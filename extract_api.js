const fs = require('fs');
const html = fs.readFileSync('C:/Users/tyxq3/.gemini/antigravity/brain/b1a21aa6-2e7b-4789-a3ac-e84336ecc894/.system_generated/steps/435/content.md', 'utf8');

// Find all URLs or endpoints in the HTML
const matches = html.match(/\/v1\/[a-zA-Z0-9_\-\/]+/g) || [];
const uniqueMatches = [...new Set(matches)];

console.log("Found endpoints:", uniqueMatches);
