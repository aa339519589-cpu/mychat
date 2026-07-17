import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { resolveRuntimeConfiguration, type RuntimeEnvironment } from '../lib/runtime-config'

const root = process.cwd()
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')

test('every GitHub Action is pinned to an immutable commit', () => {
  const workflows = readdirSync(resolve(root, '.github/workflows'))
    .filter(name => name.endsWith('.yml') || name.endsWith('.yaml'))
    .map(name => read(`.github/workflows/${name}`))
  const uses = workflows.flatMap(source => [...source.matchAll(/uses:\s*([^\s#]+)/g)])
    .map(match => match[1])
  assert.ok(uses.length > 0)
  for (const action of uses) {
    assert.match(action, /^[^@\s]+@[0-9a-f]{40}$/)
  }
})

test('release images are digest-pinned, attested, and generated only after verification', () => {
  const dockerfile = read('Dockerfile')
  const release = read('.github/workflows/release-image.yml')
  const verify = read('.github/workflows/verify.yml')
  assert.equal(
    dockerfile.match(/FROM node:24-alpine3\.23@sha256:[0-9a-f]{64}/g)?.length,
    2,
  )
  assert.match(dockerfile, /apk add --no-cache ca-certificates git/)
  assert.doesNotMatch(dockerfile, /apt-get/)
  assert.match(release, /workflow_run:/)
  assert.match(release, /github\.event\.workflow_run\.conclusion == 'success'/)
  assert.match(release, /github\.event\.workflow_run\.event == 'push'/)
  assert.match(release, /github\.event\.workflow_run\.head_branch == 'main'/)
  assert.match(release, /github\.event\.workflow_run\.head_repository\.full_name == github\.repository/)
  assert.match(release, /VERIFIED_SHA:\s*\$\{\{ github\.event\.workflow_run\.head_sha \}\}/)
  assert.doesNotMatch(release, /\$\{\{ github\.sha \}\}/)
  assert.match(release, /gh run list --workflow security\.yml --commit "\$VERIFIED_SHA"/)
  assert.match(release, /\.\[0\]\.status \+ ":" \+ \(\.\[0\]\.conclusion \/\/ ""\)/)
  assert.match(release, /completed:success/)
  assert.doesNotMatch(release, /value=latest/)
  assert.match(release, /github\.sha == github\.event\.workflow_run\.head_sha/)
  assert.match(release, /current_main=.*git\/ref\/heads\/main.*\.object\.sha/)
  assert.match(release, /artifact_name="verified-image-\$UPSTREAM_RUN_ID-\$UPSTREAM_RUN_ATTEMPT"/)
  assert.match(release, /run-id:\s*\$\{\{ github\.event\.workflow_run\.id \}\}/)
  assert.match(release, /sha256sum --check --strict manifest\.sha256/)
  assert.match(release, /node scripts\/check-migration-contract\.mjs/)
  assert.match(release, /keys == \["digest","image","migrationContractDigest","migrationContractVersion","migrationCount","revision","runAttempt","runId","schemaVersion"\]/)
  assert.match(release, /\.schemaVersion == 2/)
  assert.match(release, /io\.mychat\.schema-contract\.digest/)
  assert.match(release, /docker pull "\$IMAGE_NAME@\$IMAGE_DIGEST"/)
  assert.doesNotMatch(release, /imagetools inspect/)
  assert.match(release, /OCI revision does not match the verified commit/)
  assert.match(release, /MYCHAT_BUILD_REVISION=\$VERIFIED_SHA/)
  assert.match(release, /gh attestation verify "oci:\/\/\$IMAGE_NAME@\$IMAGE_DIGEST"/)
  assert.doesNotMatch(release, /attest-build-provenance/)

  assert.match(verify, /publish:[\s\S]*?if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/)
  assert.match(verify, /needs:[\s\S]*?- verify[\s\S]*?- container/)
  assert.match(verify, /gh run list --workflow security\.yml --commit "\$GITHUB_SHA"/)
  assert.match(verify, /--repo "\$GITHUB_REPOSITORY" --event push/)
  assert.match(verify, /\.\[0\]\.status \+ ":" \+ \(\.\[0\]\.conclusion \/\/ ""\)/)
  assert.match(verify, /ref:\s*\$\{\{ github\.sha \}\}[\s\S]*?persist-credentials:\s*false/)
  assert.match(verify, /MYCHAT_BUILD_REVISION=\$\{\{ github\.sha \}\}/)
  assert.match(verify, /org\.opencontainers\.image\.revision=\$\{\{ github\.sha \}\}/)
  assert.match(
    verify,
    /tags:\s*\$\{\{ steps\.image\.outputs\.name \}\}:sha-\$\{\{ github\.sha \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/,
  )
  assert.match(verify, /provenance:\s*mode=max/)
  assert.match(verify, /sbom:\s*true/)
  assert.match(verify, /name: Resolve sealed migration contract/)
  assert.match(verify, /io\.mychat\.schema-contract\.digest=\$\{\{ steps\.contract\.outputs\.digest \}\}/)
  assert.match(verify, /migrationContractVersion:\s*\$migrationContractVersion/)
  assert.match(verify, /migrationCount:\s*\$migrationCount/)
  assert.match(verify, /actions\/attest-build-provenance@977bb373ede98d70efdf65b84cb5f73e068dcc2a/)
  const publishIndex = verify.indexOf('- name: Build and publish verified image')
  const smokeIndex = verify.indexOf('- name: Smoke test the published digest')
  const attestIndex = verify.indexOf('- name: Attest published image')
  assert.ok(publishIndex >= 0 && smokeIndex > publishIndex && attestIndex > smokeIndex)
  assert.match(verify, /published_image="\$IMAGE_NAME@\$IMAGE_DIGEST"/)
  assert.equal(
    verify.match(/bash scripts\/smoke-production-container\.sh/g)?.length,
    2,
  )
  assert.match(dockerfile, /npm ci --ignore-scripts --legacy-peer-deps/)
  assert.match(dockerfile, /npm prune --ignore-scripts --omit=dev --legacy-peer-deps/)
  assert.match(dockerfile, /ARG MYCHAT_BUILD_REVISION=unknown/)
  assert.match(dockerfile, /LABEL org\.opencontainers\.image\.revision=\$MYCHAT_BUILD_REVISION/)
  assert.match(dockerfile, /MYCHAT_BUILD_REVISION=\$MYCHAT_BUILD_REVISION/)
  assert.match(dockerfile, /\/app\/supabase\/migrations\.manifest\.json \.\/supabase\/migrations\.manifest\.json/)
  assert.match(read('scripts/smoke-production-container.sh'), /Container migration contract does not match the verified checkout/)
})

test('CI loads and starts the exact revision-bearing production container', () => {
  const verify = read('.github/workflows/verify.yml')
  assert.match(verify, /npm ci --ignore-scripts --legacy-peer-deps/)
  assert.match(verify, /pgvector\/pgvector:pg16@sha256:[0-9a-f]{64}/)
  assert.match(verify, /name: Container runtime/)
  assert.match(verify, /docker\/build-push-action@[0-9a-f]{40}/)
  assert.match(verify, /load:\s*true/)
  assert.match(verify, /MYCHAT_BUILD_REVISION=\$\{\{ github\.sha \}\}/)
  assert.match(verify, /org\.opencontainers\.image\.revision=\$\{\{ github\.sha \}\}/)
  const smoke = read('scripts/smoke-production-container.sh')
  assert.match(smoke, /docker image inspect[\s\S]*?\.Config\.Cmd/)
  assert.match(smoke, /docker run --detach --name/)
  const smokeEnvironment = Object.fromEntries(
    [...smoke.matchAll(/^\s*--env ([A-Z0-9_]+)=([^\\\s]+) \\$/gm)]
      .map(([, name, value]) => [name, value]),
  ) as RuntimeEnvironment
  assert.deepEqual(Object.keys(smokeEnvironment).sort(), [
    'AGENT_CREDENTIAL_KEY',
    'AGENT_PUBLIC_URL',
    'DEEPSEEK_API_KEY',
    'E2B_API_KEY',
    'GITHUB_CLIENT_ID',
    'GITHUB_CLIENT_SECRET',
    'METRICS_BEARER_TOKEN',
    'MYCHAT_MAINTENANCE_MODE',
    'MYCHAT_RUNTIME_ROLE',
    'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    'NEXT_PUBLIC_SUPABASE_URL',
    'STREAM_ADMISSION_HASH_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
  ])
  assert.equal(smokeEnvironment.MYCHAT_RUNTIME_ROLE, 'all')
  assert.equal(smokeEnvironment.MYCHAT_MAINTENANCE_MODE, 'drain')
  assert.doesNotThrow(() => resolveRuntimeConfiguration({
    ...smokeEnvironment,
    NODE_ENV: 'production',
    MYCHAT_BUILD_REVISION: '0'.repeat(40),
  }))
  assert.match(smoke, /http:\/\/127\.0\.0\.1:3000\/api\/live/)
  assert.match(smoke, /verified_sha:0:12/)
  assert.match(smoke, /docker top "\$container" -eo pid,args/)
  assert.match(smoke, /grep --fixed-strings 'next-server'/)
  assert.match(smoke, /--import tsx job-worker\.ts/)
  assert.match(smoke, /for attempt in \{1\.\.6\}/)
  assert.equal(verify.match(/npm run test:migrations/g)?.length ?? 0, 0)
  assert.match(verify, /run: npm run verify/)
})

test('release promotion ties one verified SHA to the image digest and exact Render deploy', () => {
  const activation = read('.github/workflows/activate-production.yml')
  const release = read('.github/workflows/release-image.yml')
  const render = read('render.yaml')
  assert.match(activation, /workflow_run:/)
  assert.match(activation, /workflows:\s*\n\s*- Release Image/)
  assert.match(activation, /github\.event\.workflow_run\.conclusion == 'success'/)
  assert.match(activation, /github\.event\.workflow_run\.event == 'workflow_run'/)
  assert.match(activation, /github\.event\.workflow_run\.head_branch == 'main'/)
  assert.match(activation, /github\.event\.workflow_run\.head_repository\.full_name == github\.repository/)
  assert.match(activation, /DRAIN_RELEASE_RUN_ID:\s*\$\{\{ github\.event_name == 'workflow_run' && github\.event\.workflow_run\.id \|\| inputs\.drain_release_run_id \}\}/)
  assert.match(activation, /REQUESTED_REVISION:\s*\$\{\{ github\.event_name == 'workflow_run' && github\.event\.workflow_run\.head_sha \|\| inputs\.revision \}\}/)
  assert.match(activation, /drain_release_run_id=\$DRAIN_RELEASE_RUN_ID/)
  assert.match(activation, /run-id:\s*\$\{\{ steps\.release\.outputs\.drain_release_run_id \}\}/)

  assert.match(release, /deployments:\s*write/)
  assert.match(release, /^  promote:[\s\S]*?^    environment:[\s\S]*?^      name:\s*Production-Drain$/m)
  assert.ok((release.match(/current_main=.*git\/ref\/heads\/main.*\.object\.sha/g)?.length ?? 0) >= 2)
  assert.match(release, /imageDigest:\s*\$digest/)
  assert.match(release, /promotion:\s*"render-api-exact-commit-drain"/)
  assert.match(release, /RENDER_API_KEY:\s*\$\{\{ secrets\.RENDER_API_KEY \}\}/)
  assert.match(release, /RENDER_SERVICE_ID:\s*\$\{\{ secrets\.RENDER_SERVICE_ID \}\}/)
  assert.match(release, /--data '\{"autoDeploy":"no"\}'/)
  assert.match(release, /--request PUT --data '\{"value":"drain"\}'/)
  assert.doesNotMatch(release, /services\/\$RENDER_SERVICE_ID\/restart/)
  assert.ok(
    release.indexOf('- name: Preflight the existing production runtime')
      < release.indexOf('- name: Put the existing production revision into drain'),
  )
  const preflight = release.slice(
    release.indexOf('- name: Preflight the existing production runtime'),
    release.indexOf('- name: Put the existing production revision into drain'),
  )
  assert.equal(preflight.match(/HEALTH_CHECK_ATTEMPTS=3/g)?.length, 2)
  assert.equal(preflight.match(/HEALTH_CHECK_RETRY_MS=5000/g)?.length, 2)
  assert.equal(preflight.match(/HEALTH_CHECK_TIMEOUT_MS=60000/g)?.length, 2)
  assert.ok(
    release.indexOf('- name: Put the existing production revision into drain')
      < release.indexOf('- name: Wait for the existing production drain deploy'),
  )
  assert.ok(
    release.indexOf('- name: Wait for the existing production drain deploy')
      < release.indexOf('- name: Require the existing production revision to be drained'),
  )
  assert.match(release, /if EXPECTED_WORKER_DRAINING=true[\s\S]*?EXPECTED_WORKER_DRAINING=false/)
  assert.match(release, /repos\/\$GITHUB_REPOSITORY\/commits\/\$runtime_revision/)
  assert.match(release, /existing_revision=\$existing_revision/)
  assert.match(release, /ALREADY_DRAINED:\s*\$\{\{ steps\.phase\.outputs\.already_drained \}\}/)
  assert.match(release, /EXISTING_REVISION:\s*\$\{\{ steps\.phase\.outputs\.existing_revision \}\}/)
  assert.match(release, /if \[\[ "\$ALREADY_DRAINED" != "true" \]\]; then/)
  assert.match(release, /jq -nc --arg commitId "\$EXISTING_REVISION"[\s\S]*?'\{commitId: \$commitId\}'/)
  assert.match(release, /RENDER_DEPLOY_ID:\s*\$\{\{ steps\.existing-drain\.outputs\.deploy_id \}\}/)
  assert.match(release, /commit" != "\$EXISTING_REVISION"/)
  assert.match(release, /EXPECTED_REVISION:\s*\$\{\{ steps\.phase\.outputs\.existing_revision \}\}/)
  assert.match(release, /Render's deploy creation endpoint is not documented as idempotent/)
  assert.doesNotMatch(release, /render_api --request POST/)
  assert.ok(
    release.indexOf('- name: Record production deployment in progress')
      < release.indexOf('- name: Promote the exact verified revision to Render'),
  )
  assert.match(release, /jq -nc --arg commitId "\$VERIFIED_SHA" '\{commitId: \$commitId\}'/)
  assert.match(release, /api\.render\.com\/v1\/services\/\$RENDER_SERVICE_ID\/deploys/)
  assert.match(release, /\.commit\.id \/\/ empty/)
  assert.match(release, /commit" != "\$VERIFIED_SHA"/)
  assert.match(release, /PRODUCTION_READY_URL:\s*https:\/\/mychat-nm6x\.onrender\.com\/api\/ready/)
  assert.match(release, /EXPECTED_REVISION:\s*\$\{\{ github\.event\.workflow_run\.head_sha \}\}/)
  assert.match(release, /EXPECTED_WORKER_DRAINING:\s*'true'/)
  assert.match(release, /node scripts\/check-production-health\.mjs "\$PRODUCTION_READY_URL"/)
  assert.doesNotMatch(release, /\.checks\.worker\.draining == false/)
  assert.match(release, /drainDeploymentId:\s*\$drainDeploymentId/)
  assert.match(release, /schemaVersion:\s*3/)
  assert.match(release, /migrationContractDigest:\s*\$migrationContractDigest/)
  assert.match(release, /migrationContractVersion:\s*\$migrationContractVersion/)
  assert.match(release, /migrationCount:\s*\$migrationCount/)
  assert.match(activation, /Checkout exact activation revision[\s\S]*?ref:\s*\$\{\{ steps\.release\.outputs\.revision \}\}/)
  assert.match(activation, /node scripts\/check-migration-contract\.mjs/)
  assert.match(activation, /keys == \["checkedAt","digest","drainDeploymentId","image","migrationContractDigest","migrationContractVersion","migrationCount"/)
  assert.match(activation, /\.schemaVersion == 3/)
  assert.match(activation, /\.drainDeploymentId \| type == "number"/)
  assert.match(activation, /drain_deployment_id="\$\(jq -er '\.drainDeploymentId'/)
  assert.match(activation, /deployments\/\$drain_deployment_id"/)
  assert.match(activation, /\.payload\.promotion == "render-api-exact-commit-drain"/)
  assert.match(activation, /\.payload\.migrationContractDigest == \$migrationContractDigest/)
  assert.match(activation, /any\(\.\[\];[\s\S]*?\.state == "success"/)
  assert.doesNotMatch(activation, /deployments\?sha=\$TARGET_SHA/)
  assert.doesNotMatch(activation, /statuses\?per_page=1"/)
  assert.match(render, /autoDeployTrigger:\s*off/)
  assert.match(render, /npm ci --ignore-scripts --legacy-peer-deps && npm run build/)
  assert.match(render, /key:\s*MYCHAT_MAINTENANCE_MODE\s*\n\s*sync:\s*false/)
  assert.doesNotMatch(render, /key:\s*MYCHAT_MAINTENANCE_MODE\s*\n\s*value:/)
})

test('security scans cannot cancel a different trigger class', () => {
  const security = read('.github/workflows/security.yml')
  assert.match(security, /group:\s*security-\$\{\{ github\.workflow \}\}-\$\{\{ github\.event_name \}\}/)
})

test('critical release and migration surfaces have explicit owners', () => {
  const owners = read('.github/CODEOWNERS')
  for (const path of ['/.github/', '/Dockerfile', '/render.yaml', '/supabase/migrations/']) {
    assert.match(owners, new RegExp(`^${path.replaceAll('/', '\\/')}\\s+@aa339519589-cpu$`, 'm'))
  }
})

test('production keepalive binds readiness to main and protected authoritative metrics', () => {
  const keepalive = read('.github/workflows/render-keepalive.yml')
  assert.match(keepalive, /EXPECTED_REVISION:\s*\$\{\{ github\.sha \}\}/)
  assert.match(keepalive, /secrets\.METRICS_BEARER_TOKEN/)
  assert.match(keepalive, /mychat_authoritative_worker_fleet_ready 1/)
  assert.match(keepalive, /mychat_authoritative_billing_release_ready 1/)
})

test('automated updates cover source, workflows, and container bases', () => {
  const dependabot = read('.github/dependabot.yml')
  for (const ecosystem of ['npm', 'github-actions', 'docker']) {
    assert.match(dependabot, new RegExp(`package-ecosystem: ${ecosystem}`))
  }
})
