'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { ensurePage, shutdownBrowser } = require('../src/browser');

class FakePage {
  constructor(options = {}) {
    this.closed = false;
    this.failWait = options.failWait === true;
    this.waitGate = options.waitGate || null;
    this.urlValue = 'about:blank';
  }
  isClosed() { return this.closed; }
  async goto(url) {
    if (this.closed) throw new Error('Target page has been closed');
    this.urlValue = url;
  }
  locator() {
    return {
      waitFor: async () => {
        if (this.closed) throw new Error('Target page has been closed');
        if (this.failWait) throw new Error('composer did not appear');
        if (this.waitGate) await this.waitGate;
      },
    };
  }
}

class FakeContext {
  constructor(page = new FakePage()) {
    this.closed = false;
    this.pageList = [page];
  }
  pages() {
    if (this.closed) throw new Error('Browser context has been closed');
    return this.pageList;
  }
  async newPage() {
    if (this.closed) throw new Error('Browser context has been closed');
    const page = new FakePage();
    this.pageList.push(page);
    return page;
  }
  async close() {
    this.closed = true;
    for (const page of this.pageList) page.closed = true;
  }
}

async function withLauncher(launch, fn) {
  const original = chromium.launchPersistentContext;
  chromium.launchPersistentContext = launch;
  try {
    await shutdownBrowser();
    await fn();
  } finally {
    await shutdownBrowser();
    chromium.launchPersistentContext = original;
  }
}

test('ensurePage clears failed initialization and can initialize successfully on the next request', async () => {
  let launches = 0;
  await withLauncher(async () => {
    launches++;
    return new FakeContext(new FakePage({ failWait: launches === 1 }));
  }, async () => {
    await assert.rejects(ensurePage(), /composer did not appear/);
    await ensurePage();
    assert.equal(launches, 2);
  });
});

test('ensurePage revives a closed page using the existing persistent context', async () => {
  let launches = 0;
  let context;
  await withLauncher(async () => {
    launches++;
    context = new FakeContext();
    return context;
  }, async () => {
    await ensurePage();
    const firstPage = context.pageList[0];
    firstPage.closed = true;

    await ensurePage();

    assert.equal(launches, 1, 'the persistent context should be reused');
    assert.equal(context.pageList.length, 2);
    assert.equal(context.pageList[1].isClosed(), false);
  });
});

test('ensurePage replaces a closed context rather than reusing stale handles', async () => {
  let launches = 0;
  let firstContext;
  await withLauncher(async () => {
    launches++;
    const context = new FakeContext();
    if (launches === 1) firstContext = context;
    return context;
  }, async () => {
    await ensurePage();
    await firstContext.close();

    await ensurePage();

    assert.equal(launches, 2);
    assert.equal(firstContext.closed, true);
  });
});


test('concurrent ensurePage calls share one initialization promise', async () => {
  let launches = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const context = new FakeContext(new FakePage({ waitGate: gate }));

  await withLauncher(async () => {
    launches++;
    return context;
  }, async () => {
    const first = ensurePage();
    const second = ensurePage();
    release();
    await Promise.all([first, second]);

    assert.equal(launches, 1);
    assert.equal(context.pageList.length, 1);
  });
});
