// Stageshow kit — copied from .devin/skills/stageshow/kit/ (dependency
// closure only: stage, cursor, keys, measure, looks, clock, util, ease,
// window chrome, and the parts this demo uses). Brand/phone/chart parts were
// left in the skill dir; add them here if a future demo needs them.

// The stage: the canvas, the script, the cursor, measuring and playback
export { Stage } from './stage'
export { useLook } from './looks'
export { useReducedMotion } from './reduced-motion'
export { inset, box, between, contains } from './measure'
export type { StageProps, Play, LookTokens } from './stage'
export type { Act, Script } from './act'
export type { Point, Rect, Target } from './measure'
export type { CursorKind, CursorStyle } from './cursor'
export type { Theme, Palette, Fidelity, Layout } from './looks'
export type { KeysAt } from './keys'
export { clock, installVirtualClock } from './clock'
export type { ClockControl } from './clock'

// Window chrome and text/bar placeholders
export { Window, Bar, Text, Prompt, Caret } from './window'

// Parts
export { Row } from './parts/Row'
export { Avatar } from './parts/Avatar'
export { Button } from './controls/Button'
export { Badge } from './controls/Badge'

// Motion
export { Collapse } from './motion/Collapse'
export { Fly } from './motion/Fly'
export { Roll } from './motion/Roll'
