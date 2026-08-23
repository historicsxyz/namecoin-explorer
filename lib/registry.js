'use strict';

// Retired. Full-registry dumps via name_scan (50k pages) held cs_main and
// were replaced by lib/ingest.js (block-follow + 500-row name_scan bootstrap).

class RegistryService {
  constructor() {
    throw new Error(
      'RegistryService is retired. Use IngestService from lib/ingest.js ' +
      '(block-follow indexer, name_scan pages of 500).'
    );
  }
}

module.exports = { RegistryService };
