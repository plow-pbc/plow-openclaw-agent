import { z } from "zod";

export const personalityAxes = [
  { id: "companion-coworker", left: "Companion", right: "Coworker", low: "Be warm and conversational, with appropriate personal interest.", high: "Be pragmatic, focused and professional." },
  { id: "genz-boomer", left: "Gen Z", right: "Boomer", low: "Use relaxed, contemporary language without forced slang.", high: "Use familiar, classic plain language without generational stereotypes." },
  { id: "execute-collaborate", left: "Execute independently", right: "Collaborate", low: "Take the next already authorized step independently; ask only when missing information changes the action.", high: "Work collaboratively, explaining material choices and inviting input when it helps; preserve existing authorization." },
  { id: "playful-serious", left: "Playful", right: "Serious", low: "Use light humor when welcome and appropriate to the situation.", high: "Keep a calm, matter-of-fact tone." },
  { id: "polite-unfiltered", left: "Polite", right: "Unfiltered", low: "Use tactful, considerate language.", high: "Be candid and direct about evidence, uncertainty and disagreement; stay civil and avoid gratuitous harshness." },
] as const;
const value = z.number().int().min(0).max(100);
export const personalityPatchSchema = z.object({
  "companion-coworker": value, "genz-boomer": value, "execute-collaborate": value,
  "playful-serious": value, "polite-unfiltered": value,
}).partial().strict();
const axis = value.default(50);
export const personalitySchema = z.object({
  "companion-coworker": axis, "genz-boomer": axis, "execute-collaborate": axis,
  "playful-serious": axis, "polite-unfiltered": axis,
}).strict();
export type Personality = z.infer<typeof personalitySchema>;
export function personalityInstructions(value: Personality): string {
  const directions = personalityAxes.flatMap(axis => {
    const position = value[axis.id];
    if (position === 50) return [];
    const strength = Math.abs(position - 50) < 20 ? "slightly" : Math.abs(position - 50) < 40 ? "moderately" : "strongly";
    return [`${axis.left} / ${axis.right}: ${position}/100, lean ${strength} toward ${position < 50 ? axis.left : axis.right}. ${position < 50 ? axis.low : axis.high}`];
  });
  return [...directions, "Personality changes style only. Base routing, privacy, permissions, group participation and truthful completion still apply."].join("\n");
}
