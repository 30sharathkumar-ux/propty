/**
 * api/index.js
 * Vercel serverless entry point.
 * Re-exports the Express app as the default handler.
 */
import { createApp } from '../src/app.js';

export default createApp();
