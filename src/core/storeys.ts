/** Heights from floor counts: what a mapped floor is worth, and what stands above the counted ones. Pure code. */

/**
 * What stands above the counted floors when the map gives a floor count and nothing about the roof: roof, parapet and the
 * taller ground floor. Measured, not assumed: on 887 buildings of Paris, London, Zurich and Amsterdam the laser's top stood
 * 3 to 4 m above floors x 3.2 m up to five floors, 2 m at six, 1 m from seven up, where roofs are flat more often.
 * Where the roof's own floors are mapped and counted at 2.8 m each, the top still stood 2 to 3 m higher (165 buildings in Zurich and Paris).
 * Checked afterwards on 838 buildings of four cities not used to derive it (Rotterdam, Antwerp, Lyon, Manchester): the bias
 * fell from -4.7 to -2.3 m and the typical error from 5.0 to 3.5 m. It improved six boxes of seven and worsened one; from
 * city to city storeys differ by more than any single rule can follow, so this stays a prior and not a measure.
 */
export function aboveLevels(levels: number, roofShape?: string, roofLevelsMapped = false) {
  if (roofShape === "flat") return 1;
  const open = levels <= 5 ? 3 : levels === 6 ? 2 : 1;
  return roofLevelsMapped ? Math.min(2, open) : open;
}

export const STOREY_MIN = 5;

/**
 * The storey height that explains a box's buildings mapped with both a height and a floor count, drawn towards 3.2 m when
 * they are few: with n of them the estimate moves n/(n+10) of the way. `roof` is what stands above the counted floors.
 * Floors of other buildings are worth this much here. Checked on eleven boxes: only three had five such buildings, and
 * there the typical error of level-derived heights went from 1.2 to 0.5 m (Rotterdam), 3.4 to 2.8 m (Manchester centre)
 * and 3.5 to 3.6 m (Amsterdam, eight buildings). The calibrating buildings carry a height, the scored ones only floors.
 * Shadows cannot stand in for missing tags: their slope is tuned on these same level-derived heights, so they would only
 * give 3.2 m back.
 */
export function storeyHeight(rows: { height: number; levels: number; roof: number }[]) {
  const per = rows.map((row) => (row.height - row.roof) / row.levels).filter((v) => v > 1.5 && v < 8).sort((a, b) => a - b);
  if (per.length < STOREY_MIN) return { metres: 3.2, samples: per.length };
  const middle = per.length % 2 ? per[per.length >> 1]! : (per[per.length / 2 - 1]! + per[per.length / 2]!) / 2;
  return { metres: 3.2 + ((middle - 3.2) * per.length) / (per.length + 10), samples: per.length };
}
