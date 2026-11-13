#!/usr/bin/env node
import { main } from './main.ts';

main(process.argv.slice(2)).catch((e: unknown) => {
  console.error(`strikecraft: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
