export type House = "gryffindor" | "slytherin" | "ravenclaw" | "hufflepuff";

export interface SortResult {
  house: House;
  confidence: number;
  reasoning: string;
}

export interface PatronusResult {
  form: string;
  corporeal: boolean;
}

export interface FlooTravelResult {
  success: boolean;
  traceId: string;
  greenFlameParticles: boolean;
}

export interface QuidditchEvent {
  type: "snitch_sighting" | "goal" | "bludger" | "foul" | "final";
  timestamp: number;
  message: string;
  progress: number;
}
