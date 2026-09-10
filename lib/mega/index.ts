/**
 * MEGA integration module.
 *
 * All MEGA-specific logic lives here - URL parsing, embed URL generation,
 * metadata retrieval and thumbnail extraction. React components should only
 * consume these functions (or values already persisted in the database) and
 * never re-implement MEGA parsing/formatting.
 */

export * from './parser';
export * from './embed';
export * from './metadata';
export * from './thumbnail';
export * from './util';
export * from './nodes';
export * from './envelope';
export * from './attributes';
export * from './account';