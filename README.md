# Salesforce Tickets GitHub PR Linker

A Chrome extension that automatically finds and links GitHub pull requests to Salesforce tickets based on ticket numbers.

## Features

- Automatically scans Salesforce Lightning ticket boards for ticket numbers (e.g., WEB-6280)
- Searches GitHub for pull requests with matching ticket numbers in the title
- Displays PR badges directly on ticket cards with links to the pull requests
- Supports both public and private repositories (with proper GitHub token)
- Real-time updates when new tickets are loaded

## Installation

1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" in the top right corner
4. Click "Load unpacked" and select the extension directory
5. The extension icon will appear in your Chrome toolbar

## Setup

1. Click on the extension icon in your Chrome toolbar
2. Enter your GitHub Personal Access Token
   - Go to [GitHub Settings > Personal Access Tokens](https://github.com/settings/tokens)
   - Create a new token with `repo` scope (for private repositories)
   - Copy and paste the token into the extension popup
3. Click "Save Token"

## Usage

1. Navigate to your Salesforce Lightning ticket board (e.g., `https://storeconnect.lightning.force.com/lightning/o/Ticket__c/list`)
2. The extension will automatically scan for ticket numbers and search for matching GitHub PRs
3. PR badges will appear on ticket cards showing:
   - Green badges for open PRs
   - Purple badges for closed/merged PRs
   - PR number (e.g., #5758) that links directly to the GitHub PR

## How it Works

The extension searches GitHub for pull requests with titles that start with `[TICKET-NUMBER]`, for example:
- `[WEB-6280] Fix Square in CI checkOtp issue`
- `[API-1234] Add new authentication endpoint`

## Security

- Your GitHub token is stored securely in Chrome's sync storage
- The extension only runs on Salesforce Lightning domains
- No data is sent to external servers except GitHub's API

## Troubleshooting

- Make sure your GitHub token has the correct permissions
- Verify that your PRs follow the naming convention `[TICKET-NUMBER] Description`
- Check the browser console for any error messages
- Reload the Salesforce page after updating your GitHub token