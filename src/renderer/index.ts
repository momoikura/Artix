/** Public surface of the Artix galaxy renderer. */

export * from './layout.ts';
export * from './quality.ts';
export { SpatialGrid } from './spatial-index.ts';
export type { GridQueryResult } from './spatial-index.ts';
export { CameraRig } from './camera-rig.ts';
export type { CameraState, FlightOptions, RigLimits } from './camera-rig.ts';
export { GalaxyScene } from './galaxy-scene.ts';
export type { GalaxyCallbacks, GalaxyOptions, ScreenLabel } from './galaxy-scene.ts';
export { GalaxyControls } from './controls.ts';
export type { ControlCallbacks } from './controls.ts';
