// Content script for Salesforce Lightning to find tickets and add GitHub PR links

class SalesforceGitHubLinker {
  constructor() {
    this.token = null;
    this.processedTickets = new Set();
    this.init();
  }

  async init() {
    // Get stored GitHub token
    const result = await chrome.storage.sync.get(['githubToken']);
    this.token = result.githubToken;

    // Start processing tickets if we have a token
    if (this.token) {
      this.startProcessing();
    } else {
      console.log('No GitHub token found. Please configure in extension popup.');
    }

    // Listen for token updates
    chrome.runtime.onMessage.addListener((message) => {
      if (message.action === 'tokenUpdated') {
        this.refreshToken();
      }
    });
  }

  async refreshToken() {
    const result = await chrome.storage.sync.get(['githubToken']);
    this.token = result.githubToken;
    if (this.token) {
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
    if (!this.token) return;

    const ticketCards = document.querySelectorAll('.pipelineViewCard');
    
    for (const card of ticketCards) {
      const ticketNumber = this.extractTicketNumber(card);
      if (ticketNumber && !this.processedTickets.has(ticketNumber)) {
        this.processedTickets.add(ticketNumber);
        await this.addGitHubLinks(card, ticketNumber);
      }
    }
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
      // Search for PRs using the background script
      const response = await new Promise((resolve) => {
        chrome.runtime.sendMessage({
          action: 'searchGitHubPRs',
          ticketNumber: ticketNumber,
          token: this.token
        }, resolve);
      });

      if (response.success && response.prs.length > 0) {
        this.insertPRBadges(card, response.prs);
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