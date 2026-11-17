import assert from 'node:assert/strict'
import test from 'node:test'
import { createComponentHarness } from './helpers/react-harness.mjs'
import { setLocale } from '../src/i18n.js'

async function renderReleases(t, releases) {
  setLocale('zh-CN')
  const page = await createComponentHarness(new URL('../src/screens/ClientReleases.jsx', import.meta.url), {
    dependencies: { '../api.js': { can: () => false, api: {
      clientReleases: async () => ({ releases }), clientReleaseNotes: async () => ({ notes: [] }),
      clientUpdateAttempts: async () => ({ attempts: [], counts: {} }),
    } }, '../ui.jsx': { Icon: 'Icon', Loading: 'Loading' }, './client-releases.css': {} },
  })
  t.after(() => { page.unmount(); setLocale('zh-CN') })
  page.render()
  await page.flush()
  return page
}

function releaseRows(versions) {
  return versions.map((version, index) => ({ id: String(index), version,
    channel: version.includes('-beta.') ? 'beta' : 'stable', platform: 'linux',
    artifactName: `SoduWork-${version}-linux-x64.deb` }))
}

function versionHeadings(page) {
  return page.nodes(node => node.props.className === 'cr-version')
    .map(node => node.props.children[0].props.children.join(''))
}

test('a stable release precedes its own beta builds, whose indexes sort numerically', async t => {
  const page = await renderReleases(t, releaseRows(['1.13.17-beta.9', '1.13.17', '1.13.17-beta.10']))
  assert.deepEqual(versionHeadings(page), ['v1.13.17', 'v1.13.17-beta.10', 'v1.13.17-beta.9'])
})

test('core version numbers take precedence over the stable or beta stage', async t => {
  const page = await renderReleases(t, releaseRows([
    '1.13.17', '1.14.0-beta.1', '1.9.99', '1.13.18-beta.1', '2.0.0-beta.1', '1.13.9', '1.13.10',
  ]))
  assert.deepEqual(versionHeadings(page), [
    'v2.0.0-beta.1', 'v1.14.0-beta.1', 'v1.13.18-beta.1', 'v1.13.17', 'v1.13.10', 'v1.13.9', 'v1.9.99',
  ])
})

test('legacy beta channels and platform packages retain their existing grouping and order', async t => {
  const version = '1.13.17'
  const releases = [
    { id: 'legacy-beta', version, channel: 'beta', platform: 'linux', artifactName: 'beta.deb' },
    { id: 'linux-tar', version, channel: 'stable', platform: 'linux', artifactName: 'package.tar.gz' },
    { id: 'linux-rpm', version, channel: 'stable', platform: 'linux', artifactName: 'package.rpm' },
    { id: 'mac', version, channel: 'stable', platform: 'darwin', artifactName: 'package.dmg' },
    { id: 'windows', version, channel: 'stable', platform: 'win32', artifactName: 'package.exe' },
    { id: 'linux-deb', version, channel: 'stable', platform: 'linux', artifactName: 'package.deb' },
  ]
  const before = structuredClone(releases)
  const page = await renderReleases(t, releases)
  assert.deepEqual(page.nodes(node => node.props.className === 'cr-group').map(node => node.key), [
    `${version}\u0000stable`, `${version}\u0000beta`,
  ])
  assert.deepEqual(page.nodes(node => node.props.className === 'cr-row').map(node => node.key), [
    'windows', 'mac', 'linux-deb', 'linux-rpm', 'linux-tar', 'legacy-beta',
  ])
  assert.deepEqual(releases, before)
})
