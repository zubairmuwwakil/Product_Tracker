import { SupplementPriority } from "@prisma/client";
import { closeDb, prisma } from "../src/db.js";

type StackItem = {
  key: string;
  name: string;
  priority: SupplementPriority;
  targetMinAmount?: number;
  targetMaxAmount?: number;
  targetUnit?: string;
  frequency?: string;
  instructions?: string;
  rationale?: string;
};

const stack: StackItem[] = [
  {
    key: "need.supplement.creatine-monohydrate",
    name: "Creatine Monohydrate",
    priority: SupplementPriority.CORE,
    targetMinAmount: 3,
    targetMaxAmount: 5,
    targetUnit: "g/day",
    frequency: "daily",
    rationale: "Muscle, strength, aesthetics, and potential cognitive benefit.",
  },
  {
    key: "need.supplement.vitamin-d3",
    name: "Vitamin D3",
    priority: SupplementPriority.CORE,
    targetMinAmount: 2500,
    targetMaxAmount: 2500,
    targetUnit: "IU/day",
    frequency: "daily",
    instructions: "Current target; revise when repeat 25-OH-D results justify a change.",
    rationale: "Maintain adequate vitamin D status.",
  },
  {
    key: "need.supplement.magnesium-glycinate",
    name: "Magnesium Glycinate / Bisglycinate",
    priority: SupplementPriority.CORE,
    targetMinAmount: 200,
    targetMaxAmount: 350,
    targetUnit: "mg elemental/day",
    frequency: "daily",
    rationale: "Sleep support, muscle function, and dietary coverage.",
  },
  {
    key: "need.supplement.psyllium-fiber",
    name: "Fiber / Psyllium",
    priority: SupplementPriority.CORE,
    frequency: "daily / as needed",
    instructions: "Use enough to keep bowel movements regular.",
    rationale: "Digestion, cholesterol, glucose control, and general dietary fiber coverage.",
  },
  {
    key: "need.supplement.probiotic",
    name: "Probiotic",
    priority: SupplementPriority.CORE,
    frequency: "daily",
    instructions: "Use the product dose for the probiotic that reliably helps.",
    rationale: "Keep because there is a noticeable GI benefit.",
  },
  {
    key: "need.supplement.protein-powder",
    name: "Protein Powder",
    priority: SupplementPriority.CORE,
    frequency: "as needed",
    instructions: "Use only as needed to hit the daily protein target.",
    rationale: "Convenient protein gap-filler rather than a mandatory daily dose.",
  },
  {
    key: "need.supplement.vitamin-c",
    name: "Vitamin C",
    priority: SupplementPriority.CORE,
    targetMinAmount: 100,
    targetMaxAmount: 250,
    targetUnit: "mg/day",
    frequency: "optional daily",
    rationale: "Low-dose dietary insurance when fruit and vegetable intake is low.",
  },
  {
    key: "need.supplement.fish-oil",
    name: "Fish Oil",
    priority: SupplementPriority.OPTIONAL,
    targetMinAmount: 1,
    targetMaxAmount: 1,
    targetUnit: "g EPA+DHA/day",
    frequency: "daily when fatty-fish intake is low",
    rationale: "Optional omega-3 coverage when fatty fish is rarely eaten.",
  },
  {
    key: "need.supplement.collagen-peptides",
    name: "Collagen Peptides",
    priority: SupplementPriority.OPTIONAL,
    targetMinAmount: 5,
    targetMaxAmount: 10,
    targetUnit: "g/day",
    frequency: "daily if used",
    rationale: "Optional skin/aesthetics and possible joint/tendon support.",
  },
  {
    key: "need.supplement.electrolytes",
    name: "Electrolytes",
    priority: SupplementPriority.SITUATIONAL,
    frequency: "as needed",
    instructions: "Use for long workouts, heavy sweating, or hot weather.",
    rationale: "Replace electrolytes when losses are meaningfully elevated.",
  },
  {
    key: "need.supplement.caffeine",
    name: "Caffeine",
    priority: SupplementPriority.SITUATIONAL,
    targetMinAmount: 1,
    targetMaxAmount: 3,
    targetUnit: "mg/kg",
    frequency: "before training as needed",
    instructions: "Use only when it will not interfere with sleep.",
    rationale: "Situational performance and cognition boost.",
  },
  {
    key: "need.supplement.zinc",
    name: "Zinc",
    priority: SupplementPriority.SITUATIONAL,
    targetMaxAmount: 10,
    targetUnit: "mg/day",
    frequency: "only when supplementing",
    instructions: "Avoid chronic high-dose use.",
    rationale: "Modest supplementation only when dietary intake or context makes it useful.",
  },
];

async function main(): Promise<void> {
  const results: Array<{ key: string; needId: string; priority: SupplementPriority }> = [];

  for (const item of stack) {
    const need = await prisma.inventoryNeed.upsert({
      where: { key: item.key },
      create: {
        key: item.key,
        name: item.name,
        aisle: "Supplements",
        backupTarget: 1,
        reorderPoint: 1,
        notes: "Managed supplement inventory need.",
      },
      update: {
        name: item.name,
        aisle: "Supplements",
        active: true,
      },
    });

    await prisma.supplementPlan.upsert({
      where: { needId: need.id },
      create: {
        needId: need.id,
        priority: item.priority,
        targetMinAmount: item.targetMinAmount,
        targetMaxAmount: item.targetMaxAmount,
        targetUnit: item.targetUnit,
        frequency: item.frequency,
        instructions: item.instructions,
        rationale: item.rationale,
      },
      update: {
        priority: item.priority,
        targetMinAmount: item.targetMinAmount,
        targetMaxAmount: item.targetMaxAmount,
        targetUnit: item.targetUnit,
        frequency: item.frequency,
        instructions: item.instructions,
        rationale: item.rationale,
        active: true,
      },
    });

    results.push({ key: item.key, needId: need.id, priority: item.priority });
  }

  console.log(JSON.stringify({ upserted: results.length, supplements: results }, null, 2));
}

try {
  await main();
} finally {
  await closeDb();
}
