// Content script for Salesforce Lightning to find tickets and add GitHub PR links

class SalesforceGitHubLinker {
  constructor() {
    this.token = null
    this.organization = null
    this.ignoredColumns = ['Parked', 'Done']
    this.processedTickets = new Set()
    this.skippedTickets = new Set()
    this.rateLimitQueue = []
    this.isProcessingQueue = false
    this.domainKey = this.getDomainKey()
    this.mutationObserver = null
    this.hasFoundTickets = false
    this.init()
  }

  async init() {
    // Get stored GitHub settings
    const result = await chrome.storage.sync.get(['githubToken', 'githubOrganization', 'ignoredColumns'])
    this.token = result.githubToken
    this.organization = result.githubOrganization
    this.ignoredColumns = this.parseIgnoredColumns(result.ignoredColumns || 'Parked, Done')

    // Load stored skipped tickets for this domain
    await this.loadSkippedTickets()

    // Clean up old domain data periodically (once per session)
    await this.cleanupOldDomains()

    // Start processing tickets if we have both token and organization
    if (this.token && this.organization) {
      this.startProcessing()
    } else {
      console.log('GitHub token or organization not configured. Please configure in extension popup.')
    }

    // Listen for settings updates
    chrome.runtime.onMessage.addListener((message) => {
      if (message.action === 'settingsUpdated') {
        this.refreshSettings()
      }
    })
  }

  async refreshSettings() {
    const result = await chrome.storage.sync.get(['githubToken', 'githubOrganization', 'ignoredColumns'])
    this.token = result.githubToken
    this.organization = result.githubOrganization
    this.ignoredColumns = this.parseIgnoredColumns(result.ignoredColumns || 'Parked, Done')
    if (this.token && this.organization) {
      this.processedTickets.clear()
      // Clear skipped tickets when settings change - columns might have changed
      this.skippedTickets.clear()
      await this.clearStoredSkippedTickets()
      this.startProcessing()
    }
  }

  startProcessing() {
    // Process existing tickets
    this.processTickets()

    // Always set up observer for card re-rendering when tickets are moved
    this.setupMutationObserver()
  }

  setupMutationObserver() {
    // Clean up existing observer if any
    if (this.mutationObserver) {
      this.mutationObserver.disconnect()
    }

    this.mutationObserver = new MutationObserver((mutations) => {
      let shouldProcess = false

      mutations.forEach((mutation) => {
        if (mutation.type === 'childList') {
          mutation.addedNodes.forEach((node) => {
            if (node.nodeType === Node.ELEMENT_NODE) {
              // Check if new ticket cards were added
              if (node.classList?.contains('pipelineViewCard') ||
                node.querySelector?.('.pipelineViewCard')) {
                shouldProcess = true
              }
            }
          })
        }
      })

      if (shouldProcess) {
        setTimeout(() => this.processTickets(), 500)
      }
    })

    // Observe the main content area
    const targetNode = document.body
    this.mutationObserver.observe(targetNode, { childList: true, subtree: true })
    console.log('🔍 MutationObserver started - monitoring for tickets and card re-renders')
  }

  stopMutationObserver() {
    if (this.mutationObserver) {
      this.mutationObserver.disconnect()
      this.mutationObserver = null
      console.log('🛑 MutationObserver stopped - tickets found and processed')
    }
  }

  async processTickets() {
    if (!this.token || !this.organization) {
      console.log('Skipping ticket processing - missing token or organization')
      console.log('Token exists:', !!this.token)
      console.log('Organization exists:', !!this.organization)
      return
    }

    const ticketCards = document.querySelectorAll('.pipelineViewCard')
    console.log('Found', ticketCards.length, 'ticket cards')

    // Track that we've found tickets (for logging purposes)
    if (ticketCards.length > 0 && !this.hasFoundTickets) {
      this.hasFoundTickets = true
      console.log('✅ First-time tickets found - MutationObserver will continue running for card re-renders')
    }

    // If still no tickets, keep waiting
    if (ticketCards.length === 0) {
      console.log('⏳ No tickets found yet, waiting...')
      return
    }

    // First, immediately show cached results for all visible tickets
    await this.showCachedResults(ticketCards)

    // Sort tickets prioritizing those without cached PRs, then by column position
    const sortedCards = await this.sortTicketsByPriorityAndColumn(Array.from(ticketCards))
    console.log('Sorted tickets prioritizing uncached tickets, then by column position')
    console.log('First 5 tickets in processing order:',
      sortedCards.slice(0, 5).map(card => this.extractTicketNumber(card)))

    // Group tickets by column for cleaner logging
    const ticketsByColumn = new Map()
    const newlySkippedTickets = []
    let hasNewSkips = false

    for (const card of sortedCards) {
      const ticketNumber = this.extractTicketNumber(card)
      if (ticketNumber && !this.processedTickets.has(ticketNumber)) {
        const column = card.closest('.pipelineColumn')
        const header = column?.querySelector('.pipelineHeader')
        const columnName = header ? header.textContent.trim() : 'Unknown Column'

        // Check if already known to be skipped
        if (this.skippedTickets.has(ticketNumber)) {
          this.processedTickets.add(ticketNumber)
          continue
        }

        // Check if ticket is in ignored column
        if (this.isTicketInIgnoredColumn(card)) {
          newlySkippedTickets.push(`${ticketNumber} (${columnName})`)
          this.skippedTickets.add(ticketNumber)
          this.processedTickets.add(ticketNumber)
          hasNewSkips = true
          continue
        }

        if (!ticketsByColumn.has(columnName)) {
          ticketsByColumn.set(columnName, [])
        }
        ticketsByColumn.get(columnName).push(ticketNumber)

        this.processedTickets.add(ticketNumber)
        this.rateLimitQueue.push({ card, ticketNumber })
      }
    }

    // Save skipped tickets if we found new ones
    if (hasNewSkips) {
      await this.saveSkippedTickets()
    }

    // Show tickets by column in processing order
    console.log('=== Tickets by Column (in processing order) ===')
    ticketsByColumn.forEach((tickets, columnName) => {
      console.log(`📋 ${columnName}: ${tickets.join(', ')}`)
    })

    if (newlySkippedTickets.length > 0) {
      console.log('🚫 Newly skipped tickets in ignored columns:', newlySkippedTickets.join(', '))
    }

    const totalSkipped = this.skippedTickets.size
    if (totalSkipped > 0) {
      console.log(`🚫 Total skipped tickets for ${this.domainKey}: ${totalSkipped}`)
      console.log('🚫 Ignored columns:', this.ignoredColumns.join(', '))
    }

    const ticketLimit = 100
    console.log(`🚧 DEBUG: Processing only first ${ticketLimit} tickets for now`)
    this.rateLimitQueue = this.rateLimitQueue.slice(0, ticketLimit)
    console.log(`Queue reduced to ${this.rateLimitQueue.length} tickets:`,
      this.rateLimitQueue.map(item => item.ticketNumber))

    // Start processing the queue if not already running
    if (!this.isProcessingQueue) {
      this.processQueue()
    }
  }

  async showCachedResults(ticketCards) {
    console.log('📦 Loading cached results for immediate display')
    const cachedPromises = []

    for (const card of ticketCards) {
      const ticketNumber = this.extractTicketNumber(card)
      if (ticketNumber && !this.isTicketInIgnoredColumn(card)) {
        const promise = this.showCachedPRsForTicket(card, ticketNumber)
        cachedPromises.push(promise)
      }
    }

    // Wait for all cached results to be shown
    await Promise.allSettled(cachedPromises)
    console.log(`📦 Finished showing cached results for ${cachedPromises.length} tickets`)
  }

  async showCachedPRsForTicket(card, ticketNumber) {
    try {
      // Check if this ticket already has PR badges
      const existingPRContainer = card.querySelector('.github-pr-links')
      if (existingPRContainer) {
        console.log(`📦 ${ticketNumber} already has PR badges, skipping cached display`)
        return false
      }

      const cachedResponse = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          action: 'getCachedPRs',
          ticketNumber: ticketNumber,
          organization: this.organization,
          domain: this.domainKey
        }, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message))
          } else {
            resolve(response)
          }
        })
      })

      if (cachedResponse.success && cachedResponse.cachedData && cachedResponse.cachedData.prs) {
        console.log(`📦 Showing cached ${cachedResponse.cachedData.prs.length} PRs for ${ticketNumber}`)
        this.insertPRBadges(card, cachedResponse.cachedData.prs)
        return true
      }
      return false
    } catch (error) {
      console.error(`Error loading cached data for ${ticketNumber}:`, error)
      return false
    }
  }

  async processQueue() {
    if (this.isProcessingQueue) return

    this.isProcessingQueue = true
    console.log('Starting to process queue with', this.rateLimitQueue.length, 'tickets')

    while (this.rateLimitQueue.length > 0) {
      const { card, ticketNumber } = this.rateLimitQueue.shift()
      console.log('Processing ticket from queue:', ticketNumber)

      try {
        await this.addGitHubLinks(card, ticketNumber)
      } catch (error) {
        console.error('Error processing ticket', ticketNumber, error)
      }

      // Wait 1 second between API calls to avoid rate limiting
      if (this.rateLimitQueue.length > 0) {
        console.log('Waiting 1 second before next API call...')
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
    }

    this.isProcessingQueue = false
    console.log('Finished processing queue')
  }

  async sortTicketsByPriorityAndColumn(cards) {
    // Get all pipeline columns and their positions
    const kanbanView = document.querySelector('#kanbanView')
    if (!kanbanView) {
      console.log('Kanban view not found, using default order')
      return cards
    }

    const columns = Array.from(kanbanView.querySelectorAll('.pipelineColumn'))
    console.log('Found', columns.length, 'pipeline columns')

    // Create a map of column positions (rightmost = 0, leftmost = highest index)
    const columnOrder = new Map()
    const columnInfo = []

    columns.forEach((column, index) => {
      const header = column.querySelector('.pipelineHeader')
      const headerText = header ? header.textContent.trim() : `Column ${index}`
      const processingOrder = columns.length - 1 - index // Reverse order (rightmost first)

      columnInfo.push({ headerText, processingOrder })
      columnOrder.set(column, processingOrder)
    })

    // Check cache status for each ticket
    const cardsWithCacheStatus = await Promise.all(cards.map(async (card) => {
      const ticketNumber = this.extractTicketNumber(card)
      let needsFreshData = true // Default to needing fresh data
      
      if (ticketNumber) {
        try {
          const cachedResponse = await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({
              action: 'getCachedPRs',
              ticketNumber: ticketNumber,
              organization: this.organization,
              domain: this.domainKey
            }, (response) => {
              if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message))
              } else {
                resolve(response)
              }
            })
          })
          
          // Only consider it as NOT needing fresh data if it has cached data with PRs > 0
          if (cachedResponse.success && cachedResponse.cachedData && cachedResponse.cachedData.prs && cachedResponse.cachedData.prs.length > 0) {
            needsFreshData = false
          }
        } catch (error) {
          console.error(`Error checking cache for ${ticketNumber}:`, error)
        }
      }

      return { card, ticketNumber, needsFreshData }
    }))

    // Show the processing order
    console.log('=== Column Processing Order ===')
    columnInfo
      .sort((a, b) => a.processingOrder - b.processingOrder)
      .forEach((col, idx) => {
        console.log(`${idx + 1}. "${col.headerText}" (priority: ${col.processingOrder})`)
      })

    // Count tickets by fresh data needs
    const needsFreshCount = cardsWithCacheStatus.filter(item => item.needsFreshData).length
    const hasFreshDataCount = cardsWithCacheStatus.filter(item => !item.needsFreshData).length
    console.log(`=== Cache Status ===`)
    console.log(`📦 Tickets with cached PRs (>0): ${hasFreshDataCount}`)
    console.log(`🔄 Tickets needing fresh data (no cache or 0 PRs): ${needsFreshCount} (will be prioritized)`)

    // Sort cards: tickets needing fresh data first (sorted by column RHS to LHS), then tickets with cached PRs (sorted by column RHS to LHS)
    return cardsWithCacheStatus.sort((a, b) => {
      // First priority: fresh data needs (tickets needing fresh data first)
      if (a.needsFreshData && !b.needsFreshData) return -1
      if (!a.needsFreshData && b.needsFreshData) return 1
      
      // Within same cache status, sort by column position (rightmost first)
      const columnA = a.card.closest('.pipelineColumn')
      const columnB = b.card.closest('.pipelineColumn')

      const orderA = columnOrder.get(columnA) ?? 999
      const orderB = columnOrder.get(columnB) ?? 999

      return orderA - orderB // Lower order = higher priority (rightmost first)
    }).map(item => item.card)
  }

  sortTicketsByColumn(cards) {
    // Get all pipeline columns and their positions
    const kanbanView = document.querySelector('#kanbanView')
    if (!kanbanView) {
      console.log('Kanban view not found, using default order')
      return cards
    }

    const columns = Array.from(kanbanView.querySelectorAll('.pipelineColumn'))
    console.log('Found', columns.length, 'pipeline columns')

    // Create a map of column positions (rightmost = 0, leftmost = highest index)
    const columnOrder = new Map()
    const columnInfo = []

    columns.forEach((column, index) => {
      const header = column.querySelector('.pipelineHeader')
      const headerText = header ? header.textContent.trim() : `Column ${index}`
      const processingOrder = columns.length - 1 - index // Reverse order (rightmost first)

      columnInfo.push({ headerText, processingOrder })
      columnOrder.set(column, processingOrder)
    })

    // Show the processing order
    console.log('=== Column Processing Order ===')
    columnInfo
      .sort((a, b) => a.processingOrder - b.processingOrder)
      .forEach((col, idx) => {
        console.log(`${idx + 1}. "${col.headerText}" (priority: ${col.processingOrder})`)
      })

    // Sort cards by their column position
    return cards.sort((a, b) => {
      const columnA = a.closest('.pipelineColumn')
      const columnB = b.closest('.pipelineColumn')

      const orderA = columnOrder.get(columnA) ?? 999
      const orderB = columnOrder.get(columnB) ?? 999

      return orderA - orderB // Lower order = higher priority (rightmost first)
    })
  }

  extractTicketNumber(card) {
    // Look for the ticket number in the specific span structure
    const ticketSpan = card.querySelector('.uiOutputText[title]')
    if (ticketSpan && ticketSpan.title.match(/^[A-Z]+-\d+$/)) {
      return ticketSpan.title
    }
    return null
  }

  parseIgnoredColumns(ignoredColumnsString) {
    if (!ignoredColumnsString || typeof ignoredColumnsString !== 'string') {
      return ['Parked', 'Done'] // Default fallback
    }
    return ignoredColumnsString.split(',').map(column => column.trim()).filter(column => column.length > 0)
  }

  getDomainKey() {
    return window.location.hostname
  }

  async loadSkippedTickets() {
    const storageKey = `skippedTickets_${this.domainKey}`
    const result = await chrome.storage.local.get([storageKey])
    const stored = result[storageKey] || []
    this.skippedTickets = new Set(stored)
    console.log(`Loaded ${stored.length} skipped tickets for domain ${this.domainKey}`)
  }

  async saveSkippedTickets() {
    const storageKey = `skippedTickets_${this.domainKey}`
    const ticketsArray = Array.from(this.skippedTickets)
    await chrome.storage.local.set({ [storageKey]: ticketsArray })
  }

  async clearStoredSkippedTickets() {
    const storageKey = `skippedTickets_${this.domainKey}`
    await chrome.storage.local.remove([storageKey])
  }

  async cleanupOldDomains() {
    try {
      // Only run cleanup once per day per domain
      const lastCleanupKey = `lastCleanup_${this.domainKey}`
      const result = await chrome.storage.local.get([lastCleanupKey])
      const lastCleanup = result[lastCleanupKey] || 0
      const now = Date.now()
      const oneDayMs = 24 * 60 * 60 * 1000

      if (now - lastCleanup < oneDayMs) {
        return // Skip cleanup if done recently
      }

      // Get all storage keys
      const allData = await chrome.storage.local.get(null)
      const skippedTicketKeys = Object.keys(allData).filter(key => key.startsWith('skippedTickets_'))

      // Remove data older than 30 days for domains other than current
      const thirtyDaysMs = 30 * oneDayMs
      const keysToRemove = []

      for (const key of skippedTicketKeys) {
        const domain = key.replace('skippedTickets_', '')
        if (domain !== this.domainKey) {
          // Check if we have timestamp data for this domain
          const domainLastUsed = allData[`lastUsed_${domain}`] || 0
          if (now - domainLastUsed > thirtyDaysMs) {
            keysToRemove.push(key)
            keysToRemove.push(`lastUsed_${domain}`)
          }
        }
      }

      if (keysToRemove.length > 0) {
        await chrome.storage.local.remove(keysToRemove)
        console.log(`Cleaned up ${keysToRemove.length} old storage keys`)
      }

      // Update last cleanup time and last used time for current domain
      await chrome.storage.local.set({
        [lastCleanupKey]: now,
        [`lastUsed_${this.domainKey}`]: now
      })

    } catch (error) {
      console.error('Error during cleanup:', error)
    }
  }

  isTicketInIgnoredColumn(card) {
    const column = card.closest('.pipelineColumn')
    const header = column?.querySelector('.pipelineHeader')
    const columnName = header ? header.textContent.trim() : ''
    return this.ignoredColumns.some(ignoredColumn =>
      columnName.toLowerCase().includes(ignoredColumn.toLowerCase())
    )
  }

  async addGitHubLinks(card, ticketNumber) {
    try {
      console.log('=== Content Script Debug ===')
      console.log('Ticket number:', ticketNumber)
      console.log('Token (first 10 chars):', this.token ? this.token.substring(0, 10) + '...' : 'MISSING')
      console.log('Organization:', this.organization)

      // Show what query will be sent for fresh data
      const expectedQuery = `${ticketNumber} in:title is:pull-request org:${this.organization}`
      const expectedUrl = `https://api.github.com/search/issues?q=${encodeURIComponent(expectedQuery)}`
      console.log('Expected query:', expectedQuery)
      console.log('Expected URL:', expectedUrl)

      // Check if we already have any PR results displayed and get cached data for comparison
      const existingPRContainer = card.querySelector('.github-pr-links')
      let cachedPrs = null
      if (existingPRContainer) {
        console.log(`📦 ${ticketNumber} already has PR results displayed`)
        // Get the cached data to compare with fresh results
        try {
          const cachedResponse = await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({
              action: 'getCachedPRs',
              ticketNumber: ticketNumber,
              organization: this.organization,
              domain: this.domainKey
            }, (response) => {
              if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message))
              } else {
                resolve(response)
              }
            })
          })
          if (cachedResponse.success && cachedResponse.cachedData) {
            cachedPrs = cachedResponse.cachedData.prs
          }
        } catch (error) {
          console.error(`Error getting cached data for comparison: ${error}`)
        }
      }

      // Fetch fresh data to keep cache updated and check for changes
      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          action: 'searchGitHubPRs',
          ticketNumber: ticketNumber,
          token: this.token,
          organization: this.organization,
          domain: this.domainKey,
          skipCache: false // Let background script handle caching
        }, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message))
          } else if (!response) {
            reject(new Error('No response from background script'))
          } else {
            resolve(response)
          }
        })
      })

      if (response.success && response.prs) {
        console.log(`🔄 Fresh results for ${ticketNumber}:`, response.prs)

        // Update the UI if the results changed or we don't have existing results
        if (!cachedPrs || this.prResultsChanged(cachedPrs, response.prs)) {
          console.log(`🔄 Updating badges for ${ticketNumber} (data changed)`)
          this.insertPRBadges(card, response.prs)
        } else {
          console.log(`✅ Data unchanged for ${ticketNumber} - keeping existing badges`)
        }

        if (response.prs.length > 0) {
          console.log(`✅ Found ${response.prs.length} PRs for ${ticketNumber}`)
        } else {
          console.log(`❌ No PRs found for ${ticketNumber}`)
        }
      } else if (!response.success) {
        console.error('GitHub API error for', ticketNumber, response.error)
        // If we don't have cached results and fresh fetch failed, show nothing
        if (!existingPRContainer) {
          console.log(`❌ No cached or fresh results for ${ticketNumber}`)
        }
      }
    } catch (error) {
      console.error('Error fetching GitHub PRs for', ticketNumber, error)
    }
  }

  prResultsChanged(oldPrs, newPrs) {
    if (!oldPrs && !newPrs) return false
    if (!oldPrs || !newPrs) return true
    if (oldPrs.length !== newPrs.length) return true

    // Simple comparison by PR numbers and states
    const oldSet = new Set(oldPrs.map(pr => `${pr.number}_${pr.state}`))
    const newSet = new Set(newPrs.map(pr => `${pr.number}_${pr.state}`))

    return oldSet.size !== newSet.size || ![...oldSet].every(item => newSet.has(item))
  }


  insertPRBadges(card, prs) {
    // Find the container where we want to add the PR badges
    const cardInner = card.querySelector('.pipelineViewCardInnerWrapper')
    if (!cardInner) return

    // Add CSS styles to document if not already present
    this.ensurePRBadgeStyles()

    // Remove existing PR badges to avoid duplicates
    const existingPRContainer = cardInner.querySelector('.github-pr-links')
    if (existingPRContainer) {
      existingPRContainer.remove()
    }

    // Don't create container if no PRs
    if (!prs || prs.length === 0) return

    // Create container for PR badges
    const prContainer = document.createElement('p')
    prContainer.className = 'slds-truncate runtime_sales_pipelineboardPipelineViewCardItemStencil github-pr-links'
    prContainer.style.cssText = 'margin-top: 8px; display: flex; flex-wrap: wrap; gap: 4px;'

    // Add each PR as a badge
    prs.forEach(pr => {
      const badge = document.createElement('a')
      badge.href = pr.url
      badge.target = '_blank'
      badge.title = `${pr.title} (${pr.repository})`
      badge.textContent = `#${pr.number}`

      // Use CSS classes for state
      badge.className = `pr-badge ${pr.state === 'open' ? 'open' : 'closed'}`

      prContainer.appendChild(badge)
    })

    // Insert the PR container before the assistive text span
    const assistiveText = cardInner.querySelector('.assistiveText')
    if (assistiveText) {
      cardInner.insertBefore(prContainer, assistiveText)
    } else {
      cardInner.appendChild(prContainer)
    }
  }

  ensurePRBadgeStyles() {
    // Check if styles are already added
    if (document.querySelector('#pr-badge-styles')) return

    const style = document.createElement('style')
    style.id = 'pr-badge-styles'
    style.textContent = `
      .pr-badge {
        color: white;
        padding: 2px 6px;
        border-radius: 3px;
        text-decoration: none;
        font-size: 11px;
        font-weight: 500;
        display: inline-block;
        transition: background-color 0.2s ease, opacity 0.3s ease;
      }

      .pr-badge.open {
        background-color: #28a745;
      }

      .pr-badge.open:hover {
        background-color: #218838;
      }

      .pr-badge.closed {
        background-color: #6f42c1;
      }

      .pr-badge.closed:hover {
        background-color: #5a32a3;
      }

    `
    document.head.appendChild(style)
  }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    new SalesforceGitHubLinker()
  })
} else {
  new SalesforceGitHubLinker()
}
