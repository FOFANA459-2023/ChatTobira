declare module "tiny-segmenter" {
  /** Compact dictionary-free Japanese segmenter (Kudo's TinySegmenter). */
  export default class TinySegmenter {
    segment(text: string): string[];
  }
}
