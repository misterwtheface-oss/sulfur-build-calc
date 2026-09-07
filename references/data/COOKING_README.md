# SULFUR Cooking / Recipe Resource
Relational cooking/recipe dataset extracted from the datamined SULFUR Unity game, built for a build calculator. The driving question: because in-game inventory space is very tight, for every pickup/ingredient know its BEST use (which recipe to make) and whether it is worth keeping vs trashing.

## Data provenance
- Items scanned: 1033 (recursively from `Items/`, id!=0).
- Recipes: 1879 total (cooking=1740, enchantment=43, generic=96).
- Item ids resolved by scanning every item `.asset`, reading `id:`/`value:`, `displayName:`, deriving `name` = asset filename and `category` = relative folder under `Items/`. Recipe `item.value` joined to this map.
- Enum decode (`EntityAttributes`, `StatModType`) parsed directly from the C# source under `code/`, honoring explicit `= N` and auto-increment.

## The key metric: `product_total_effect_per_slot`
Inventory-efficiency framing. A recipe product's buff *total effect* divided by the number of inventory slots it occupies (`inventorySize.x * inventorySize.y`, 0 treated as 1). This is the "is it worth the bag space" number: how much stat payoff you get per slot the finished food costs you.

### Buff "total effect" definition
Per the `BuffDefinition` constructor: when `totalValueOverride` is set, the game stores `value = totalValueOverride / duration`. So the total effect of a buff is:
- `totalValueOverride` if it is nonzero, else
- `value * duration`.
Raw `value` and `duration` are preserved inside `buffs_readable`.

## CSV files
### recipes.csv (1879 rows)
One row per recipe.
- `name` recipe internal name; `type_name` cooking/enchantment/generic.
- `output_name`/`output_display` the produced item; `qty_created`; `craftable` (canBeCrafted 0/1).
- `num_inputs`; `inputs_readable` (e.g. `Flour x2; Egg x1`); `inputs_raw` (`itemid:qty;...`).

### food_effects.csv (198 rows)
One row per item that HAS `buffsOnConsume` OR `addStatusOnConsume` (edible/consumable).
- `slots`, `basePrice`, `buffs_readable` (e.g. `Stat_MaxHealth Flat total=15 over 10s; ...`).
- `primary_attribute` / `primary_total_effect` = the largest-magnitude buff's attribute and total; `total_effect_per_slot` = primary_total / slots.

### ingredient_usage.csv (4887 rows) — RELATIONAL CORE
One row per (ingredient, recipe-that-consumes-it). An ingredient used in N recipes yields N rows. Carries the produced item's per-slot payoff so you can rank an ingredient's possible uses.

### ingredient_value.csv (256 rows) — ROLLUP (trash-vs-keep)
One row per item that is EITHER a recipe ingredient OR directly consumable.
- `direct_consume_primary` = its own primary buff total if edible raw, else blank.
- `num_recipes_using`; `best_use_recipe` / `best_use_product` / `best_use_product_per_slot` = the recipe using it whose product has the highest per-slot payoff.
- `verdict` = KEEP / SITUATIONAL / TRASH (heuristic below).

## Verdict heuristic (a heuristic, NOT gospel)
Thresholds chosen for a tight-inventory roguelike; tune to taste:
- `PER_SLOT_MEANINGFUL = 5.0` — a product's per-slot payoff at or above this counts as "meaningfully positive".
- `DIRECT_LARGE = 15.0` — a raw-edible item whose own primary buff total is at or above this counts as a "large beneficial buff".

Rules (evaluated in order):
- **KEEP** if (`num_recipes_using>=1` AND `best_use_product_per_slot >= 5.0`) OR (`direct_consume_primary >= 15.0`).
- **SITUATIONAL** if it only feeds low-value products, or is edible-raw with a small/short (or negative) buff, or is a non-food item in a protected category (equipment/weapon/ammo/etc.) with no cooking use.
- **TRASH** if `num_recipes_using==0` AND it is not directly consumable (no buffs, no status) AND its category is not one of the protected non-junk categories.

**Note on TRASH being empty:** this CSV's candidate set is, by the spec, only items that are EITHER a recipe ingredient OR directly consumable. Every candidate therefore has at least one recipe use or a consumable buff, so the TRASH condition (no recipes AND not consumable) is structurally unreachable inside this table — TRASH count is 0. A genuinely worthless pickup is one that appears in neither `ingredient_usage.csv` nor `food_effects.csv`; the calculator can treat absence from this rollup as the real "trash" signal. The verdict column here therefore separates KEEP (worth the bag space) from SITUATIONAL (marginal).

Protected (non-trash) category tokens: `equipment`, `weapon`, `currency`, `key`, `quest`, `ammo`, `attachment`, `enchantment`, `manual`, `grenade`, `throwable`, `tool`, `gun`, `melee`, `armor`, `backpack`, `container`.

## Caveats
- Values are **extract, not golden** — sourced from the datamined asset dump, not hand-verified against live play.
- Some buffs are `PercentAdd` (200) or `PercentMult` (300), not `Flat` (100). The per-slot number treats all totals as comparable magnitudes; a percent buff and a flat buff are NOT the same unit. Read `buffs_readable` for the mod type.
- Negative-value buffs are debuffs (e.g. bad food). They lower `primary_total_effect` and push items toward SITUATIONAL/TRASH.
- Enum decode is derived from decompiled/exported C# source; if the enum changed between builds, attribute names could drift.
- `addStatusOnConsume` entries are folded into `buffs_readable` as `status:Name=Value` and only used as a primary when an item has no true buffs.
- Unresolved recipe item ids (2): 0, 924.

---

## pickup_guide.csv — the capstone "what do I do with this pickup?" table
Built by `pickup_guide.py` (unifies items.csv + ingredient_value.csv + food_effects.csv).
One row per item (1034) with a single **verdict** for tight-inventory decisions:

| verdict | meaning | count |
|---|---|---|
| KEEP-USE | functional: weapon/gear/attachment/ammo/enchant/oil/repair/utility (by category or `useType`) | 742 |
| KEEP-COOK/EAT | edible AND a cooking ingredient — cook it or eat it | 198 |
| KEEP-COOK | pure cooking ingredient — see `best_dish` / `best_dish_per_slot` | 58 |
| SELL | high-value, no other use (Valuables, Mutagen) — sell for cash | 21 |
| SELL-LOW | minor vendor value (Organs, Banana) — sell if bag is tight | 12 |
| META | endless-mode meta upgrade, not a physical pickup | 3 |
| TRASH | none — **nothing in SULFUR is pure delete-trash** | 0 |

**Key takeaway for tight inventory:** there is no true "trash" — the real decision is
SELL vs KEEP. Among edibles/ingredients, rank by `best_dish_per_slot` (buff total ÷ slots).
Highest-value dishes: Hot Sauce (~12000/slot), Anti-Poison Gum (~9600), Egg Toddy (~7200).
`role`/`useType` columns explain WHY each item is KEEP-USE. Verdict is a heuristic
(extract-not-golden); "total effect" = totalValueOverride if set else value×duration, so
long-duration/override buffs score high — compare within a buff type.
