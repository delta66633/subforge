const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const appSource = fs.readFileSync('app.js', 'utf8');
const htmlSource = fs.readFileSync('index.html', 'utf8');
const context = {
    console,
    document: {
        addEventListener() {},
        querySelector() { return null; },
    },
};

vm.createContext(context);
vm.runInContext(appSource, context);

const settings = {
    splitMode: 'word',
    maxChars: 42,
    maxLines: 2,
    maxDuration: 7000,
    minGap: 0,
    speakerDiarization: false,
    includeSpeakerLabel: false,
    extendSubtitles: false,
    breakAtCommas: true,
};
const tokens = [
    { text: 'Hel', start_ms: 0, end_ms: 150 },
    { text: 'lo', start_ms: 150, end_ms: 400 },
    { text: ' world', start_ms: 400, end_ms: 800 },
    { text: '!', start_ms: 800, end_ms: 850 },
];

const wordSubs = JSON.parse(JSON.stringify(context.buildSubtitles(tokens, settings)));
assert.deepEqual(wordSubs, [
    { start_ms: 0, end_ms: 400, text: 'Hello' },
    { start_ms: 400, end_ms: 850, text: 'world!' },
]);

const lengthSubs = JSON.parse(JSON.stringify(context.buildSubtitles(tokens, {
    ...settings,
    splitMode: 'length',
})));
assert.deepEqual(lengthSubs, [
    { start_ms: 0, end_ms: 850, text: 'Hello world!' },
]);

assert.match(htmlSource, /<option value="word">단어 단위 \(한 단어씩\)<\/option>/);

console.log('Word-level subtitle tests passed.');
