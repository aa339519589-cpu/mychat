import assert from 'node:assert/strict'
import test from 'node:test'
import { safeRevision } from '../lib/supabase/health'

const renderRevision = '61b43b027fe6703b2f6c9535cb8068dbdc23b115'
const staleBuildRevision = 'ed49f093b47aefcc5239ddf2587d3f69953f2f71'

test('Render runtime commit is authoritative over a stale build revision marker', () => {
  assert.equal(safeRevision({
    RENDER: 'true',
    RENDER_GIT_COMMIT: renderRevision,
    MYCHAT_BUILD_REVISION: staleBuildRevision,
  }), '61b43b027fe6')
})

test('build revision remains the fallback outside Render', () => {
  assert.equal(safeRevision({ MYCHAT_BUILD_REVISION: staleBuildRevision }), 'ed49f093b47a')
})
