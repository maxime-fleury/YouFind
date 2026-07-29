import { db, stmts } from "../src/db.js";
import { scoreChannel } from "../src/llm.js";
import { runWithLimit } from "../src/utils.js";

const unscored = db.query(`SELECT * FROM channels WHERE status = 'rejected' AND llm_score IS NULL ORDER BY date_ajout DESC`).all();
console.log(`Found ${unscored.length} unscored rejected channels.`);

let scored = 0;
let errors = 0;

await runWithLimit(unscored, async (ch) => {
  try {
    const result = await scoreChannel(ch.channel_id);
    if (result?.score != null) {
      scored++;
      if (scored % 10 === 0) console.log(`  Progress: ${scored}/${unscored.length}`);
    } else {
      errors++;
    }
  } catch (e) {
    errors++;
    if (errors <= 3) console.error(`  Error on ${ch.nom}: ${e.message}`);
  }
}, 4, 500);

console.log(`\nDone: ${scored} scored, ${errors} errors out of ${unscored.length}`);
process.exit(0);
