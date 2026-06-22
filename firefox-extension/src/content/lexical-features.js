// lexical-features.js
// extracts speaker commitment to an utterance from transcript text alone

// -- word lists

const EXCLUSIVE_WORDS = new Set([
  'but', 'except', 'without', 'exclude', 'excluding', 'however',
  'although', 'unless', 'despite', 'rather', 'instead', 'yet',
  'nonetheless', 'nevertheless', 'notwithstanding', 'whereas'
]);

const HEDGING_WORDS = new Set([
  'maybe', 'perhaps', 'possibly', 'probably', 'might', 'could',
  'seems', 'appear', 'appears', 'apparently', 'roughly', 'around',
  'approximately', 'somewhat', 'kind of', 'sort of', 'i think',
  'i believe', 'i feel', 'i guess', 'i suppose', 'not sure',
  'uncertain', 'unclear', 'allegedly', 'supposedly', 'purportedly'
]);

const CERTAINTY_WORDS = new Set([
  'always', 'never', 'definitely', 'certainly', 'absolutely',
  'clearly', 'obviously', 'undoubtedly', 'without question',
  'proven', 'fact', 'facts', 'evidence', 'study', 'studies',
  'research', 'data', 'statistics', 'percent', '%', 'million',
  'billion', 'every', 'all', 'none', 'guaranteed'
]);

const EMOTIONAL_WORDS = new Set([
  'terrible', 'horrible', 'awful', 'great', 'amazing', 'fantastic',
  'disaster', 'catastrophe', 'wonderful', 'incredible', 'unbelievable',
  'disgrace', 'shameful', 'outrageous', 'ridiculous', 'pathetic',
  'love', 'hate', 'fear', 'angry', 'anger', 'sad', 'happy',
  'excited', 'disgusted', 'afraid', 'scared', 'worried', 'proud',
  'ashamed', 'brilliant', 'stupid', 'evil', 'corrupt'
]);

const FILLER_WORDS = new Set([
  'uh', 'um', 'uhh', 'umm', 'er', 'err', 'like', 'you know',
  'i mean', 'basically', 'literally', 'actually', 'honestly',
  'frankly', 'right', 'okay', 'so', 'well', 'anyway'
]);

const FIRST_PERSON_SINGULAR = new Set([
  'i', 'me', 'my', 'mine', 'myself'
]);

const FIRST_PERSON_PLURAL = new Set([
  'we', 'us', 'our', 'ours', 'ourselves'
]);

const THIRD_PERSON = new Set([
  'they', 'them', 'their', 'theirs', 'he', 'she', 'his', 'her',
  'it', 'its', 'him'
]);

// -- main extractor

/**
 * extract lexical commitment features from a transcript string
 * @param {string} text - the transcript chunk
 * @param {number} durationSeconds - approximate duration (optional, for speech rate)
 * @returns {object} feature object
 */
function extractLexicalFeatures(text, durationSeconds) {
  const lower = text.toLowerCase();
  const words = lower.match(/\b\w+\b/g) || [];
  const wordCount = words.length;

  if (wordCount === 0) return null;

  let exclusiveCount  = 0;
  let hedgingCount    = 0;
  let certaintyCount  = 0;
  let emotionalCount  = 0;
  let fillerCount     = 0;
  let firstPersonSing = 0;
  let firstPersonPlur = 0;
  let thirdPerson     = 0;

  for (const word of words) {
    if (EXCLUSIVE_WORDS.has(word))        exclusiveCount++;
    if (HEDGING_WORDS.has(word))          hedgingCount++;
    if (CERTAINTY_WORDS.has(word))        certaintyCount++;
    if (EMOTIONAL_WORDS.has(word))        emotionalCount++;
    if (FILLER_WORDS.has(word))           fillerCount++;
    if (FIRST_PERSON_SINGULAR.has(word))  firstPersonSing++;
    if (FIRST_PERSON_PLURAL.has(word))    firstPersonPlur++;
    if (THIRD_PERSON.has(word))           thirdPerson++;
  }

  // also check multi-word phrases
  if (lower.includes('i think'))    hedgingCount++;
  if (lower.includes('i believe'))  hedgingCount++;
  if (lower.includes('i guess'))    hedgingCount++;
  if (lower.includes('i suppose'))  hedgingCount++;
  if (lower.includes('sort of'))    hedgingCount++;
  if (lower.includes('kind of'))    hedgingCount++;
  if (lower.includes('you know'))   fillerCount++;
  if (lower.includes('i mean'))     fillerCount++;

  // -- rates (per 100 words for normalization) 

  const per100 = (n) => parseFloat(((n / wordCount) * 100).toFixed(1));

  // -- rough speech rate calculation

  const wordsPerSecond = durationSeconds && durationSeconds > 0
    ? parseFloat((wordCount / durationSeconds).toFixed(1))
    : null;

  // -- avg word length (proxy for phoneme density) 

  const avgWordLength = parseFloat(
    (words.reduce((sum, w) => sum + w.length, 0) / wordCount).toFixed(1)
  );

  // -- commitment score (heuristic -1 to +1) 
  // positive = high commitment, negative = low commitment
  // certainty words and first-person singular push positive
  // hedging words and filler push negative
  // emotional words push negative (overconfidence is a form of low precision)

  const commitmentScore = parseFloat((
    (certaintyCount * 0.3)
    + (firstPersonSing * 0.15)
    - (hedgingCount * 0.4)
    - (fillerCount * 0.25)
    - (emotionalCount * 0.1)
    + (exclusiveCount * 0.1) // exclusive words signal careful qualification
  ).toFixed(2));

  const commitmentLabel =
    commitmentScore >  0.3 ? 'HIGH'   :
    commitmentScore < -0.3 ? 'LOW'    :
                             'MEDIUM';

  // -- result

  return {
    wordCount,
    wordsPerSecond,
    avgWordLength,
    rates: {
      hedging:       per100(hedgingCount),
      certainty:     per100(certaintyCount),
      emotional:     per100(emotionalCount),
      filler:        per100(fillerCount),
      exclusive:     per100(exclusiveCount),
      firstPersonSg: per100(firstPersonSing),
      firstPersonPl: per100(firstPersonPlur),
      thirdPerson:   per100(thirdPerson),
    },
    commitmentScore,
    commitmentLabel,
    // human-readable summary for Claude
    summary: buildSummary({
      wordCount, wordsPerSecond, hedgingCount, certaintyCount,
      emotionalCount, fillerCount, exclusiveCount,
      firstPersonSing, firstPersonPlur, commitmentLabel
    })
  };
}

function buildSummary({ wordCount, wordsPerSecond, hedgingCount, certaintyCount,
  emotionalCount, fillerCount, exclusiveCount, firstPersonSing,
  firstPersonPlur, commitmentLabel }) {

  const parts = [];

  if (wordsPerSecond !== null) {
    const rateDesc = wordsPerSecond > 3.5 ? 'fast' : wordsPerSecond < 2 ? 'slow' : 'moderate';
    parts.push(`speech rate: ${wordsPerSecond} words/sec (${rateDesc})`);
  }

  if (hedgingCount > 0)
    parts.push(`${hedgingCount} hedging expression${hedgingCount > 1 ? 's' : ''} (e.g. "maybe", "I think")`);

  if (fillerCount > 0)
    parts.push(`${fillerCount} filler word${fillerCount > 1 ? 's' : ''} (e.g. "um", "you know")`);

  if (certaintyCount > 0)
    parts.push(`${certaintyCount} certainty marker${certaintyCount > 1 ? 's' : ''} (e.g. "always", "definitely", statistics)`);

  if (emotionalCount > 0)
    parts.push(`${emotionalCount} emotional word${emotionalCount > 1 ? 's' : ''}`);

  if (exclusiveCount > 0)
    parts.push(`${exclusiveCount} exclusive/qualifying word${exclusiveCount > 1 ? 's' : ''} (e.g. "but", "except")`);

  if (firstPersonSing > 0)
    parts.push(`${firstPersonSing} first-person singular pronoun${firstPersonSing > 1 ? 's' : ''} (I/me/my)`);

  if (firstPersonPlur > 0)
    parts.push(`${firstPersonPlur} first-person plural pronoun${firstPersonPlur > 1 ? 's' : ''} (we/our)`);

  const summary = parts.length
    ? `Lexical features: ${parts.join(', ')}. Overall commitment: ${commitmentLabel}.`
    : `No strong commitment signals detected. Overall commitment: ${commitmentLabel}.`;

  return summary;
}