#!/usr/bin/env node
// Syncs skills/nostr-dvm/ files into the template string in src/index.ts
// Run: npm run sync-skill

import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const SKILL_DIR = join(ROOT, 'skills', 'nostr-dvm')
const INDEX_PATH = join(ROOT, 'src', 'index.ts')

// 1. Read SKILL.md
let skill = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8')

// Strip the "Detailed Guides" section at the end (## 6. Detailed Guides ... EOF)
skill = skill.replace(/\n## 6\. Detailed Guides[\s\S]*$/, '')

// 2. Read reference files in alphabetical order
const refsDir = join(SKILL_DIR, 'references')
const refFiles = readdirSync(refsDir).filter(f => f.endsWith('.md')).sort()
const refs = refFiles.map(f => readFileSync(join(refsDir, f), 'utf8'))

// 3. Concatenate: skill content + each reference separated by blank lines
let combined = skill.trimEnd() + '\n'
for (const ref of refs) {
  combined += '\n' + ref.trimEnd() + '\n'
}

// 4. Apply template variable replacements
//    Order matters: longer/more-specific patterns first

// frontmatter external-api line
combined = combined.replace(
  /^(\s*external-api:\s*)https:\/\/2020117\.xyz\s*$/m,
  '$1${baseUrl}'
)
// frontmatter description line — "the 2020117 decentralized"
combined = combined.replace(
  /the 2020117 decentralized/g,
  'the ${appName} decentralized'
)
// Title: "# 2020117 — "
combined = combined.replace(
  /^# 2020117 — /m,
  '# ${appName} — '
)
// NIP-05 line: "username@2020117.xyz"
combined = combined.replace(
  /username@2020117\.xyz/g,
  'username@${new URL(baseUrl).host}'
)
// "your-agent@2020117.xyz" in NIP-05 verification section
combined = combined.replace(
  /your-agent@2020117\.xyz/g,
  'your-agent@${new URL(baseUrl).host}'
)
// Base URL line: "Base URL: https://2020117.xyz"
combined = combined.replace(
  /Base URL: https:\/\/2020117\.xyz/g,
  'Base URL: ${baseUrl}'
)
// All remaining https://2020117.xyz → ${baseUrl}
combined = combined.replace(/https:\/\/2020117\.xyz/g, '${baseUrl}')

// 5. Escape for JS template literal
//    First escape backticks: ` → \`
combined = combined.replace(/`/g, '\\`')
//    Then escape ${ that are NOT our template variables
//    Our variables: ${baseUrl}, ${appName}, ${new URL(baseUrl).host}
//    Strategy: temporarily protect our vars, escape all ${, restore
const PLACEHOLDER_MAP = [
  ['${baseUrl}', '__TMPL_BASEURL__'],
  ['${appName}', '__TMPL_APPNAME__'],
  ['${new URL(baseUrl).host}', '__TMPL_HOST__'],
]
for (const [real, placeholder] of PLACEHOLDER_MAP) {
  // After backtick escaping, our vars look like: \${baseUrl} etc. — no, wait.
  // The replacements in step 4 inserted literal ${baseUrl} etc.
  // But step 5 escaped backticks. ${...} doesn't contain backticks, so they're intact.
  combined = combined.replaceAll(real, placeholder)
}
// Now escape all remaining ${
combined = combined.replace(/\$\{/g, '\\${')
// Restore our template variables
for (const [real, placeholder] of PLACEHOLDER_MAP) {
  combined = combined.replaceAll(placeholder, real)
}

// 6. Write into src/index.ts between markers
const indexSrc = readFileSync(INDEX_PATH, 'utf8')

const START_MARKER = '// --- GENERATED SKILL.MD START (do not edit manually, run: npm run sync-skill) ---'
const END_MARKER = '// --- GENERATED SKILL.MD END ---'

const startIdx = indexSrc.indexOf(START_MARKER)
const endIdx = indexSrc.indexOf(END_MARKER)

if (startIdx === -1 || endIdx === -1) {
  console.error('ERROR: Could not find GENERATED SKILL.MD markers in src/index.ts')
  process.exit(1)
}

const before = indexSrc.slice(0, startIdx + START_MARKER.length)
const after = indexSrc.slice(endIdx)

const newBlock = `\n  const md = \`${combined}\`\n  `

const newSrc = before + newBlock + after
writeFileSync(INDEX_PATH, newSrc, 'utf8')

console.log('sync-skill: src/index.ts updated from skills/nostr-dvm/')
