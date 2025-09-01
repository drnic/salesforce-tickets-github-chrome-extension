// Background script for handling extension lifecycle and API requests

chrome.runtime.onInstalled.addListener(() => {
  console.log('Salesforce Tickets GitHub PR Linker installed');
});

// Handle messages from content script for GitHub API calls
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'searchGitHubPRs') {
    searchGitHubPRs(request.ticketNumber, request.token)
      .then(prs => sendResponse({ success: true, prs }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Keep the message channel open for async response
  }
});

async function searchGitHubPRs(ticketNumber, token) {
  const query = `[${ticketNumber}] in:title type:pr`;
  
  try {
    const response = await fetch(`https://api.github.com/search/issues?q=${encodeURIComponent(query)}`, {
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    });

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status}`);
    }

    const data = await response.json();
    
    // Transform the results to include the info we need
    return data.items.map(pr => ({
      number: pr.number,
      title: pr.title,
      url: pr.html_url,
      repository: pr.repository_url.split('/').slice(-2).join('/'),
      state: pr.state
    }));
  } catch (error) {
    console.error('Error searching GitHub PRs:', error);
    throw error;
  }
}