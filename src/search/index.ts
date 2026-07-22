/** Public surface of the Artix search subsystem. */

export * from './query-parser.ts';
export * from './document.ts';
export * from './fuzzy.ts';
export * from './fts.ts';
export * from './rank.ts';
export * from './inverted-index.ts';
export { SearchEngine, compileFilters } from './engine.ts';
export type { EngineSource } from './engine.ts';
