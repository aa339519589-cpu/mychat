import test from "node:test"
import assert from "node:assert/strict"

import { projectMomentum, rubberband, shouldDismissGesture } from "../components/motion/fluid"

test("momentum projection follows Apple's exponential deceleration model", () => {
  assert.ok(Math.abs(projectMomentum(1000, 0.99) - 99) < Number.EPSILON * 512)
  assert.ok(Math.abs(projectMomentum(-500, 0.99) + 49.5) < Number.EPSILON * 256)
})

test("gesture dismissal accounts for position and release velocity", () => {
  assert.equal(shouldDismissGesture({
    offset: -30,
    velocity: -900,
    size: 320,
    direction: "negative",
  }), true)
  assert.equal(shouldDismissGesture({
    offset: -30,
    velocity: 500,
    size: 320,
    direction: "negative",
  }), false)
  assert.equal(shouldDismissGesture({
    offset: 130,
    velocity: 0,
    size: 320,
    direction: "positive",
  }), true)
})

test("momentum projection rejects invalid deceleration rates", () => {
  assert.throws(() => projectMomentum(100, 1), RangeError)
  assert.throws(() => projectMomentum(100, 0), RangeError)
})

test("rubber-banding remains continuous while adding edge resistance", () => {
  assert.equal(rubberband(0, 320), 0)
  assert.ok(rubberband(80, 320) > 0)
  assert.ok(rubberband(80, 320) < 80)
  assert.equal(rubberband(-80, 320), -rubberband(80, 320))
})
