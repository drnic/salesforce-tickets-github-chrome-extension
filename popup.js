document.addEventListener('DOMContentLoaded', function() {
  const tokenInput = document.getElementById('token');
  const saveButton = document.getElementById('save');
  const statusDiv = document.getElementById('status');

  // Load existing token
  chrome.storage.sync.get(['githubToken'], function(result) {
    if (result.githubToken) {
      tokenInput.value = result.githubToken;
    }
  });

  // Save token
  saveButton.addEventListener('click', function() {
    const token = tokenInput.value.trim();
    
    if (!token) {
      showStatus('Please enter a GitHub token', 'error');
      return;
    }

    // Validate token format
    if (!token.startsWith('ghp_') && !token.startsWith('github_pat_')) {
      showStatus('Invalid token format. Please use a personal access token.', 'error');
      return;
    }

    // Test the token by making a simple API call
    fetch('https://api.github.com/user', {
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    })
    .then(response => {
      if (response.ok) {
        // Save the token
        chrome.storage.sync.set({ githubToken: token }, function() {
          showStatus('Token saved successfully!', 'success');
          // Notify content script to refresh
          chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
            if (tabs[0] && tabs[0].url.includes('lightning.force.com')) {
              chrome.tabs.sendMessage(tabs[0].id, {action: 'tokenUpdated'});
            }
          });
        });
      } else {
        showStatus('Invalid token. Please check your GitHub token.', 'error');
      }
    })
    .catch(error => {
      showStatus('Error validating token. Please try again.', 'error');
    });
  });

  function showStatus(message, type) {
    statusDiv.textContent = message;
    statusDiv.className = `status ${type}`;
    statusDiv.style.display = 'block';
    
    setTimeout(() => {
      statusDiv.style.display = 'none';
    }, 3000);
  }
});