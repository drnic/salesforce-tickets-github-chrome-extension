document.addEventListener('DOMContentLoaded', function() {
  const organizationInput = document.getElementById('organization');
  const tokenInput = document.getElementById('token');
  const ignoredColumnsInput = document.getElementById('ignoredColumns');
  const saveButton = document.getElementById('save');
  const statusDiv = document.getElementById('status');

  // Load existing settings
  chrome.storage.sync.get(['githubToken', 'githubOrganization', 'ignoredColumns'], function(result) {
    if (result.githubToken) {
      tokenInput.value = result.githubToken;
    }
    if (result.githubOrganization) {
      organizationInput.value = result.githubOrganization;
    }
    if (result.ignoredColumns) {
      ignoredColumnsInput.value = result.ignoredColumns;
    } else {
      ignoredColumnsInput.value = 'Parked, Done';
    }
  });

  // Save settings
  saveButton.addEventListener('click', function() {
    const organization = organizationInput.value.trim();
    const token = tokenInput.value.trim();
    const ignoredColumns = ignoredColumnsInput.value.trim();
    
    if (!organization) {
      showStatus('Please enter a GitHub organization name', 'error');
      return;
    }
    
    if (!token) {
      showStatus('Please enter a GitHub token', 'error');
      return;
    }

    // Validate token format
    if (!token.startsWith('ghp_') && !token.startsWith('github_pat_')) {
      showStatus('Invalid token format. Please use a personal access token.', 'error');
      return;
    }

    // Start animated test sequence
    runTestSequence(token, organization);
  });

  function showStatus(message, type) {
    statusDiv.textContent = message;
    statusDiv.className = `status ${type}`;
    statusDiv.style.display = 'block';
    
    if (type === 'error') {
      setTimeout(() => {
        statusDiv.style.display = 'none';
      }, 5000);
    } else {
      // Keep success message visible when showing checklist
      setTimeout(() => {
        if (document.getElementById('checklist').style.display === 'none') {
          statusDiv.style.display = 'none';
        }
      }, 3000);
    }
  }
  
  async function runTestSequence(token, organization) {
    const testRunner = document.getElementById('test-runner');
    testRunner.style.display = 'block';
    
    let allTestsPassed = true;
    
    // Test 1: Validate GitHub token
    await runTest('test-token', 'Validating GitHub token', async () => {
      const response = await fetch('https://api.github.com/user', {
        headers: {
          'Authorization': `token ${token}`,
          'Accept': 'application/vnd.github.v3+json'
        }
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Status ${response.status}: ${errorText}`);
      }
      
      const user = await response.json();
      return `✓ Authenticated as ${user.login}`;
    });
    
    // Test 2: Check organization access
    const orgAccessible = await runTest('test-org', 'Checking organization access', async () => {
      const response = await fetch(`https://api.github.com/orgs/${organization}`, {
        headers: {
          'Authorization': `token ${token}`,
          'Accept': 'application/vnd.github.v3+json'
        }
      });
      
      if (!response.ok) {
        if (response.status === 404) {
          throw new Error('Organization not found or no access');
        }
        const errorText = await response.text();
        throw new Error(`Status ${response.status}: ${errorText}`);
      }
      
      const org = await response.json();
      return `✓ Access to ${org.name || organization}`;
    });
    
    // Test 3: Test PR search API
    await runTest('test-search', 'Testing PR search API', async () => {
      const query = `type:pr org:${organization}`;
      const response = await fetch(`https://api.github.com/search/issues?q=${encodeURIComponent(query)}&per_page=1`, {
        headers: {
          'Authorization': `token ${token}`,
          'Accept': 'application/vnd.github.v3+json'
        }
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Status ${response.status}: ${errorText}`);
      }
      
      const data = await response.json();
      return `✓ Found ${data.total_count} PRs in org`;
    });
    
    // Test 4: Test actual repository search access with exact same query format
    await runTest('test-permissions', 'Testing repository search access', async () => {
      const response = await fetch(`https://api.github.com/search/issues?per_page=1&q=org:${organization}+is:pull-request`, {
        headers: {
          'Authorization': `token ${token}`,
          'Accept': 'application/vnd.github.v3+json'
        }
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        if (response.status === 403) {
          throw new Error(`Access denied to ${organization} repositories. Token needs organization approval or proper Resource owner setup.`);
        }
        throw new Error(`Status ${response.status}: ${errorText}`);
      }
      
      const data = await response.json();
      if (data.total_count === 0) {
        throw new Error(`No PRs found in ${organization}. Token may not have access to organization repositories.`);
      }
      return `✓ Found ${data.total_count} PRs - repository access confirmed`;
    });
    
    // If all tests passed, save settings
    if (allTestsPassed) {
      chrome.storage.sync.set({ 
        githubToken: token,
        githubOrganization: organization,
        ignoredColumns: ignoredColumns
      }, function() {
        showStatus('All tests passed! Settings saved successfully.', 'success');
        
        // Notify content script to refresh
        chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
          if (tabs[0] && tabs[0].url.includes('lightning.force.com')) {
            chrome.tabs.sendMessage(tabs[0].id, {action: 'settingsUpdated'});
          }
        });
        
        // Hide test runner after 5 seconds
        setTimeout(() => {
          testRunner.style.display = 'none';
        }, 5000);
      });
    } else {
      showStatus('Some tests failed. Please check your settings.', 'error');
    }
    
    async function runTest(testId, description, testFn) {
      const testElement = document.getElementById(testId);
      const statusElement = testElement.querySelector('.test-status');
      const resultElement = testElement.querySelector('.test-result');
      
      // Set to running state
      testElement.className = 'test-item running';
      statusElement.className = 'test-status running spinner';
      statusElement.textContent = '◐';
      
      try {
        const result = await testFn();
        
        // Set to success state
        testElement.className = 'test-item success';
        statusElement.className = 'test-status success';
        statusElement.textContent = '✓';
        resultElement.textContent = result;
        
        return true;
      } catch (error) {
        // Set to error state
        allTestsPassed = false;
        testElement.className = 'test-item error';
        statusElement.className = 'test-status error';
        statusElement.textContent = '✗';
        resultElement.textContent = error.message;
        
        return false;
      }
    }
  }
});