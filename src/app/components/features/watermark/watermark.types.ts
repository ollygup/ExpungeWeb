export interface WatermarkParams {
    text: string;
    angleDeg: number;
    density: number;    // 1–5 → (n+1)×(n+1) grid
    opacity: number;    // 0.05–0.50
    fontSize: number;   // pt
    color: [number, number, number]; // RGB 0–1
  }
  
  export type WatermarkWorkerMsg = {
    type: 'apply';
    pdfBytes: Uint8Array;
    params: WatermarkParams;
  };
  
  export type WatermarkWorkerRes =
    | { type: 'success'; resultBytes: Uint8Array }
    | { type: 'error'; message: string };