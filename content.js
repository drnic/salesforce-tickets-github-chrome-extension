// Content script for Salesforce Lightning to find tickets and add GitHub PR links

class SalesforceGitHubLinker {
  constructor() {
    this.token = null;
    this.organization = null;
    this.processedTickets = new Set();
    this.rateLimitQueue = [];
    this.isProcessingQueue = false;
    this.init();
  }

  async init() {
    // Get stored GitHub settings
    const result = await chrome.storage.sync.get(['githubToken', 'githubOrganization']);
    this.token = result.githubToken;
    this.organization = result.githubOrganization;

    // Start processing tickets if we have both token and organization
    if (this.token && this.organization) {
      this.startProcessing();
    } else {
      console.log('GitHub token or organization not configured. Please configure in extension popup.');
    }

    // Listen for settings updates
    chrome.runtime.onMessage.addListener((message) => {
      if (message.action === 'settingsUpdated') {
        this.refreshSettings();
      }
    });
  }

  async refreshSettings() {
    const result = await chrome.storage.sync.get(['githubToken', 'githubOrganization']);
    this.token = result.githubToken;
    this.organization = result.githubOrganization;
    if (this.token && this.organization) {
      this.processedTickets.clear();
      this.startProcessing();
    }
  }

  startProcessing() {
    // Process existing tickets
    this.processTickets();

    // Set up observer for new tickets loaded dynamically
    this.setupMutationObserver();
  }

  setupMutationObserver() {
    const observer = new MutationObserver((mutations) => {
      let shouldProcess = false;
      
      mutations.forEach((mutation) => {
        if (mutation.type === 'childList') {
          mutation.addedNodes.forEach((node) => {
            if (node.nodeType === Node.ELEMENT_NODE) {
              // Check if new ticket cards were added
              if (node.classList?.contains('pipelineViewCard') || 
                  node.querySelector?.('.pipelineViewCard')) {
                shouldProcess = true;
              }
            }
          });
        }
      });

      if (shouldProcess) {
        setTimeout(() => this.processTickets(), 500);
      }
    });

    // Observe the main content area
    const targetNode = document.body;
    observer.observe(targetNode, { childList: true, subtree: true });
  }

  async processTickets() {
    if (!this.token || !this.organization) {
      console.log('Skipping ticket processing - missing token or organization');
      console.log('Token exists:', !!this.token);
      console.log('Organization exists:', !!this.organization);
      return;
    }

    const ticketCards = document.querySelectorAll('.pipelineViewCard');
    console.log('Found', ticketCards.length, 'ticket cards');
    
    // Sort tickets by column position (right to left)
    const sortedCards = this.sortTicketsByColumn(Array.from(ticketCards));
    console.log('Sorted tickets by column position (RHS first)');
    console.log('First 5 tickets in processing order:', 
      sortedCards.slice(0, 5).map(card => this.extractTicketNumber(card)));
    
    // Group tickets by column for cleaner logging
    const ticketsByColumn = new Map();
    for (const card of sortedCards) {
      const ticketNumber = this.extractTicketNumber(card);
      if (ticketNumber && !this.processedTickets.has(ticketNumber)) {
        const column = card.closest('.pipelineColumn');
        const header = column?.querySelector('.pipelineHeader');
        const columnName = header ? header.textContent.trim() : 'Unknown Column';
        
        if (!ticketsByColumn.has(columnName)) {
          ticketsByColumn.set(columnName, []);
        }
        ticketsByColumn.get(columnName).push(ticketNumber);
        
        this.processedTickets.add(ticketNumber);
        this.rateLimitQueue.push({ card, ticketNumber });
      }
    }
    
    // Show tickets by column in processing order
    console.log('=== Tickets by Column (in processing order) ===');
    ticketsByColumn.forEach((tickets, columnName) => {
      console.log(`📋 ${columnName}: ${tickets.join(', ')}`);
    });
    
    // Start processing the queue if not already running
    if (!this.isProcessingQueue) {
      this.processQueue();
    }
  }
  
  async processQueue() {
    if (this.isProcessingQueue) return;
    
    this.isProcessingQueue = true;
    console.log('Starting to process queue with', this.rateLimitQueue.length, 'tickets');
    
    while (this.rateLimitQueue.length > 0) {
      const { card, ticketNumber } = this.rateLimitQueue.shift();
      console.log('Processing ticket from queue:', ticketNumber);
      
      try {
        await this.addGitHubLinks(card, ticketNumber);
      } catch (error) {
        console.error('Error processing ticket', ticketNumber, error);
      }
      
      // Wait 1 second between API calls to avoid rate limiting
      if (this.rateLimitQueue.length > 0) {
        console.log('Waiting 1 second before next API call...');
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    this.isProcessingQueue = false;
    console.log('Finished processing queue');
  }

  sortTicketsByColumn(cards) {
    // Get all pipeline columns and their positions
    const kanbanView = document.querySelector('#kanbanView');
    if (!kanbanView) {
      console.log('Kanban view not found, using default order');
      return cards;
    }
    
    const columns = Array.from(kanbanView.querySelectorAll('.pipelineColumn'));
    console.log('Found', columns.length, 'pipeline columns');
    
    // Create a map of column positions (rightmost = 0, leftmost = highest index)
    const columnOrder = new Map();
    const columnInfo = [];
    
    columns.forEach((column, index) => {
      const header = column.querySelector('.pipelineHeader');
      const headerText = header ? header.textContent.trim() : `Column ${index}`;
      const processingOrder = columns.length - 1 - index; // Reverse order (rightmost first)
      
      columnInfo.push({ headerText, processingOrder });
      columnOrder.set(column, processingOrder);
    });
    
    // Show the processing order
    console.log('=== Column Processing Order ===');
    columnInfo
      .sort((a, b) => a.processingOrder - b.processingOrder)
      .forEach((col, idx) => {
        console.log(`${idx + 1}. "${col.headerText}" (priority: ${col.processingOrder})`);
      });
    
    // Sort cards by their column position
    return cards.sort((a, b) => {
      const columnA = a.closest('.pipelineColumn');
      const columnB = b.closest('.pipelineColumn');
      
      const orderA = columnOrder.get(columnA) ?? 999;
      const orderB = columnOrder.get(columnB) ?? 999;
      
      console.log(`Card ${this.extractTicketNumber(a)}: column order ${orderA}`);
      console.log(`Card ${this.extractTicketNumber(b)}: column order ${orderB}`);
      
      return orderA - orderB; // Lower order = higher priority (rightmost first)
    });
  }

  extractTicketNumber(card) {
    // Look for the ticket number in the specific span structure
    const ticketSpan = card.querySelector('.uiOutputText[title]');
    if (ticketSpan && ticketSpan.title.match(/^[A-Z]+-\d+$/)) {
      return ticketSpan.title;
    }
    return null;
  }

  async addGitHubLinks(card, ticketNumber) {
    try {
      console.log('=== Content Script Debug ===');
      console.log('Ticket number:', ticketNumber);
      console.log('Token (first 10 chars):', this.token ? this.token.substring(0, 10) + '...' : 'MISSING');
      console.log('Organization:', this.organization);
      
      // Search for PRs using the background script
      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          action: 'searchGitHubPRs',
          ticketNumber: ticketNumber,
          token: this.token,
          organization: this.organization
        }, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (!response) {
            reject(new Error('No response from background script'));
          } else {
            resolve(response);
          }
        });
      });

      if (response.success && response.prs && response.prs.length > 0) {
        this.insertPRBadges(card, response.prs);
      } else if (!response.success) {
        console.error('GitHub API error for', ticketNumber, response.error);
      }
    } catch (error) {
      console.error('Error fetching GitHub PRs for', ticketNumber, error);
    }
  }

  insertPRBadges(card, prs) {
    // Find the container where we want to add the PR badges
    const cardInner = card.querySelector('.pipelineViewCardInnerWrapper');
    if (!cardInner) return;

    // Create container for PR badges
    const prContainer = document.createElement('p');
    prContainer.className = 'slds-truncate runtime_sales_pipelineboardPipelineViewCardItemStencil github-pr-links';
    prContainer.style.cssText = 'margin-top: 8px; display: flex; flex-wrap: wrap; gap: 4px;';

    // Add each PR as a badge
    prs.forEach(pr => {
      const badge = document.createElement('a');
      badge.href = pr.url;
      badge.target = '_blank';
      badge.title = pr.title;
      badge.textContent = `#${pr.number}`;
      badge.style.cssText = `
        background-color: ${pr.state === 'open' ? '#28a745' : '#6f42c1'};
        color: white;
        padding: 2px 6px;
        border-radius: 3px;
        text-decoration: none;
        font-size: 11px;
        font-weight: 500;
        display: inline-block;
      `;

      // Add hover effect
      badge.addEventListener('mouseenter', () => {
        badge.style.backgroundColor = pr.state === 'open' ? '#218838' : '#5a32a3';
      });
      
      badge.addEventListener('mouseleave', () => {
        badge.style.backgroundColor = pr.state === 'open' ? '#28a745' : '#6f42c1';
      });

      prContainer.appendChild(badge);
    });

    // Insert the PR container before the assistive text span
    const assistiveText = cardInner.querySelector('.assistiveText');
    if (assistiveText) {
      cardInner.insertBefore(prContainer, assistiveText);
    } else {
      cardInner.appendChild(prContainer);
    }
  }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    new SalesforceGitHubLinker();
  });
} else {
  new SalesforceGitHubLinker();
}