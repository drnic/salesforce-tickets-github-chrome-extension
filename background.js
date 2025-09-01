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
  // Simplified search - just ticket number without brackets
  const query = `${ticketNumber} in:title is:pull-request org:${organization}`;
  
  console.log('=== Background Script Debug ===');
  console.log('Ticket number:', ticketNumber);
  console.log('Token (first 10 chars):', token ? token.substring(0, 10) + '...' : 'MISSING');
  console.log('Organization:', organization);
  console.log('Search query:', query);
  
  if (!token) {
    throw new Error('No GitHub token provided');
  }
  
  if (!organization) {
    throw new Error('No GitHub organization provided');
  }
  
  try {
    const fullUrl = `https://api.github.com/search/issues?q=${encodeURIComponent(query)}`;
    console.log('Full API URL:', fullUrl);
    
    const response = await fetch(fullUrl, {
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
    
    console.log('=== GitHub API Response ===');
    console.log('Total count:', data.total_count);
    console.log('Items found:', data.items.length);
    
    data.items.forEach((item, index) => {
      console.log(`Item ${index + 1}:`, {
        title: item.title,
        number: item.number,
        repository: item.repository_url.split('/').slice(-2).join('/'),
        url: item.html_url
      });
    });
    
    // Filter results to only include repositories from the specified organization
    const filteredItems = data.items.filter(pr => {
      const repoPath = pr.repository_url.split('/').slice(-2);
      const repoOrg = repoPath[0];
      const matches = repoOrg.toLowerCase() === organization.toLowerCase();
      console.log(`Repository ${pr.repository_url} - Org: ${repoOrg} - Matches ${organization}: ${matches}`);
      return matches;
    });
    
    console.log('=== After Organization Filtering ===');
    console.log('Filtered items count:', filteredItems.length);
    
    // Transform the results to include the info we need
    const result = filteredItems.map(pr => ({
      number: pr.number,
      title: pr.title,
      url: pr.html_url,
      repository: pr.repository_url.split('/').slice(-2).join('/'),
      state: pr.state
    }));
    
    console.log('Final result:', result);
    return result;
  } catch (error) {
    console.error('Error searching GitHub PRs:', error);
    throw error;
  }
}