// Background script for handling extension lifecycle and API requests

chrome.runtime.onInstalled.addListener(() => {
  console.log('Salesforce Tickets GitHub PR Linker installed');
});

// Handle messages from content script for GitHub API calls
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'searchGitHubPRs') {
    searchGitHubPRs(request.ticketNumber, request.token, request.organization)
      .then(prs => sendResponse({ success: true, prs }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Keep the message channel open for async response
  }
});

async function searchGitHubPRs(ticketNumber, token, organization) {
  const query = `[${ticketNumber}] in:title type:pr org:${organization}`;
  
  console.log('Searching GitHub with query:', query);
  console.log('Organization:', organization);
  
  try {
    const response = await fetch(`https://api.github.com/search/issues?q=${encodeURIComponent(query)}`, {
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    });

    console.log('GitHub API response status:', response.status);
    console.log('GitHub API response headers:', Object.fromEntries(response.headers.entries()));

    if (!response.ok) {
      const errorBody = await response.text();
      console.log('GitHub API error body:', errorBody);
      
      let errorMessage = `GitHub API error: ${response.status}`;
      
      if (response.status === 403) {
        try {
          const errorData = JSON.parse(errorBody);
          console.log('GitHub API error data:', errorData);
          
          if (errorData.message?.includes('rate limit')) {
            errorMessage = 'GitHub API rate limit exceeded. Please try again later.';
          } else if (errorData.message?.includes('token')) {
            errorMessage = 'Invalid GitHub token or insufficient permissions. Please check your token.';
          } else if (errorData.message?.includes('organization')) {
            errorMessage = `No access to organization "${organization}". Check if your token has access to this org.`;
          } else {
            errorMessage = `GitHub API forbidden (403): ${errorData.message || 'Check token permissions'}`;
          }
        } catch {
          errorMessage = 'GitHub API forbidden (403). Check your token and permissions.';
        }
      } else if (response.status === 401) {
        errorMessage = 'GitHub token is invalid or expired. Please update your token.';
      }
      
      throw new Error(errorMessage);
    }

    const data = await response.json();
    
    // Filter results to only include repositories from the specified organization
    const filteredItems = data.items.filter(pr => {
      const repoPath = pr.repository_url.split('/').slice(-2);
      const repoOrg = repoPath[0];
      return repoOrg.toLowerCase() === organization.toLowerCase();
    });
    
    // Transform the results to include the info we need
    return filteredItems.map(pr => ({
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