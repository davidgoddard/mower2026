/**
 * Production entrypoint.
 *
 * Run the single app/control server directly so operator pages and `/api/*`
 * share one HTTP process. This removes the public-web → local-control proxy
 * hop that could leave the page loaded while every fetch failed after a
 * control-process drop.
 */
import "./controlMain.js";
