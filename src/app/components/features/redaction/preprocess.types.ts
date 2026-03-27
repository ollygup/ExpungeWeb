export interface PreprocessRegion {
  index: number;
  blob:  Blob;
}

export interface PreprocessRequest {
  type:    'preprocess';
  id:      string;
  regions: PreprocessRegion[];
}

export interface PreprocessResult {
  index: number;
  blob:  Blob;
  scale: number;
}

export type PreprocessResponse =
  | { type: 'done';  id: string; results: PreprocessResult[] }
  | { type: 'error'; id: string; message: string };