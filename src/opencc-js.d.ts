// Type declarations for opencc-js dict sub-paths not covered by the package's
// shipped types. Each dict file exports a string in OpenCC's pipe-delimited
// "source replacement" format, compatible with ConverterFactory.
declare module 'opencc-js/dict/STCharacters' {
  const dict: string;
  export default dict;
}

declare module 'opencc-js/dict/TSCharacters' {
  const dict: string;
  export default dict;
}
