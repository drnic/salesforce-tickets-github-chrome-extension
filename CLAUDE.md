# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Extension Development

This is a Manifest V3 Chrome extension that links Salesforce tickets to GitHub pull requests.

### Testing the Extension
1. Load extension in Chrome: `chrome://extensions/` > "Load unpacked" > select this directory
2. Navigate to a Salesforce Lightning ticket board: `https://*.lightning.force.com/lightning/o/Ticket__c/list`
3. Configure GitHub token and organization via extension popup
4. Verify PR badges appear on ticket cards

### Architecture Overview

**Three-Component Architecture:**
- **content.js**: Main logic that runs on Salesforce pages, extracts ticket numbers from DOM, manages PR badge injection
- **background.js**: Service worker handling GitHub API calls via `searchGitHubPRs()` function
- **popup.js/popup.html**: Settings UI for GitHub token and organization configuration

**Data Flow:**
1. Content script extracts ticket numbers from `.uiOutputText[title]` elements matching `/^[A-Z]+-\d+$/`
2. Sends message to background script with ticket number, token, and organization
3. Background script searches GitHub API: `[TICKET-NUMBER] in:title type:pr org:ORGANIZATION`
4. Content script receives PR results and injects badges into `.pipelineViewCardInnerWrapper`

**Key DOM Targets:**
- Ticket cards: `.pipelineViewCard` 
- Ticket numbers: `.uiOutputText[title]` with regex pattern
- Badge insertion point: Before `.assistiveText` in card inner wrapper

**Storage:**
- Uses `chrome.storage.sync` for `githubToken` and `githubOrganization`
- Content script listens for `settingsUpdated` messages to refresh configuration

**GitHub API Integration:**
- Searches for PRs with `[TICKET-NUMBER]` prefix in title
- Filters by organization using `org:` query parameter
- Returns PR number, title, URL, repository, and state for badge creation

**PR Badge Styling:**
- Green badges (#28a745) for open PRs
- Purple badges (#6f42c1) for closed/merged PRs
- Clickable links to GitHub PRs with hover effects