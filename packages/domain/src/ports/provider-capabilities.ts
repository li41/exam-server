export type ProviderCapabilities = {
  transactions: "full" | "request" | "none";
  optimisticConcurrency: boolean;
  cursorPagination: boolean;
  fullTextSearch: boolean;
  resumableUpload: boolean;
  serverSideFiltering: boolean;
};
