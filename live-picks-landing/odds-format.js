(function () {
  const STORAGE_KEY = 'livePicksOddsFormat';
  const VALID_FORMATS = new Set(['decimal', 'american', 'fractional']);
  const FRACTIONAL_REGIONS = new Set(['GB', 'IE']);
  const AMERICAN_REGIONS = new Set(['US', 'CA']);
  const BOOKMAKER_FRACTIONS = [
    [1, 100], [1, 80], [1, 66], [1, 50], [1, 40], [1, 33], [1, 25], [1, 20],
    [1, 16], [1, 14], [1, 12], [1, 10], [1, 9], [1, 8], [1, 7], [1, 6],
    [1, 5], [2, 9], [1, 4], [2, 7], [3, 10], [1, 3], [4, 11], [2, 5],
    [4, 9], [1, 2], [8, 15], [11, 20], [4, 7], [8, 13], [2, 3], [8, 11],
    [4, 5], [5, 6], [10, 11], [19, 20], [1, 1], [11, 10], [6, 5], [5, 4],
    [13, 10], [4, 3], [11, 8], [7, 5], [3, 2], [8, 5], [13, 8], [5, 3],
    [17, 10], [7, 4], [9, 5], [15, 8], [19, 10], [2, 1], [21, 10], [11, 5],
    [9, 4], [23, 10], [12, 5], [5, 2], [13, 5], [8, 3], [11, 4], [14, 5],
    [3, 1], [16, 5], [17, 5], [10, 3], [7, 2], [15, 4], [4, 1], [9, 2],
    [5, 1], [11, 2], [6, 1], [13, 2], [7, 1], [15, 2], [8, 1], [17, 2],
    [9, 1], [10, 1], [11, 1], [12, 1], [14, 1], [16, 1], [20, 1], [25, 1],
    [33, 1], [40, 1], [50, 1], [66, 1], [100, 1]
  ];

  function getBrowserRegion() {
    const languages = navigator.languages && navigator.languages.length
      ? navigator.languages
      : [navigator.language || ''];

    for (const language of languages) {
      const match = String(language).match(/[-_]([a-z]{2})\b/i);
      if (match) {
        return match[1].toUpperCase();
      }
    }

    try {
      const locale = new Intl.Locale(navigator.language || '');
      return locale.region ? locale.region.toUpperCase() : '';
    } catch (error) {
      return '';
    }
  }

  function getAutoFormat() {
    const region = getBrowserRegion();

    if (FRACTIONAL_REGIONS.has(region)) {
      return 'fractional';
    }

    if (AMERICAN_REGIONS.has(region)) {
      return 'american';
    }

    return 'decimal';
  }

  function getSavedFormat() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return VALID_FORMATS.has(saved) ? saved : '';
    } catch (error) {
      return '';
    }
  }

  function getFormat() {
    return getSavedFormat() || getAutoFormat();
  }

  function setFormat(format) {
    try {
      if (!format || format === 'auto') {
        localStorage.removeItem(STORAGE_KEY);
      } else if (VALID_FORMATS.has(format)) {
        localStorage.setItem(STORAGE_KEY, format);
      }
    } catch (error) {
      // Local storage can be blocked in private browser modes.
    }

    applyOddsFormatting(document);
  }

  function parseDecimalOdds(value) {
    const text = String(value || '').trim().replace(/^\$/, '').replace(/,/g, '');

    if (!text || text === '-') {
      return null;
    }

    if (/^[+-]\d+(?:\.\d+)?$/.test(text)) {
      const american = Number(text);

      if (!Number.isFinite(american) || american === 0) {
        return null;
      }

      return american > 0
        ? 1 + american / 100
        : 1 + 100 / Math.abs(american);
    }

    const fraction = text.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);

    if (fraction) {
      const numerator = Number(fraction[1]);
      const denominator = Number(fraction[2]);

      if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0) {
        return 1 + numerator / denominator;
      }
    }

    const decimal = Number(text);
    return Number.isFinite(decimal) && decimal > 1 ? decimal : null;
  }

  function gcd(a, b) {
    let first = Math.abs(a);
    let second = Math.abs(b);

    while (second) {
      const next = first % second;
      first = second;
      second = next;
    }

    return first || 1;
  }

  function approximateBookmakerFraction(value) {
    let bestFraction = { numerator: 1, denominator: 1 };
    let bestDistance = Number.POSITIVE_INFINITY;

    BOOKMAKER_FRACTIONS.forEach(([numerator, denominator]) => {
      const divisor = gcd(numerator, denominator);
      const fraction = {
        numerator: numerator / divisor,
        denominator: denominator / divisor
      };
      const fractionValue = fraction.numerator / fraction.denominator;
      const distance = Math.abs(value - fractionValue);

      if (
        distance < bestDistance ||
        (Math.abs(distance - bestDistance) < 0.000001 && fraction.denominator < bestFraction.denominator)
      ) {
        bestDistance = distance;
        bestFraction = fraction;
      }
    });

    return bestFraction;
  }

  function formatDecimal(decimal) {
    return decimal.toFixed(2);
  }

  function formatAmerican(decimal) {
    if (decimal >= 2) {
      return `+${Math.round((decimal - 1) * 100)}`;
    }

    return `-${Math.round(100 / (decimal - 1))}`;
  }

  function formatFractional(decimal) {
    const fraction = approximateBookmakerFraction(decimal - 1);
    return `${fraction.numerator}/${fraction.denominator}`;
  }

  function formatDecimalOdds(decimal, format = getFormat()) {
    if (!Number.isFinite(decimal) || decimal <= 1) {
      return '-';
    }

    if (format === 'american') {
      return formatAmerican(decimal);
    }

    if (format === 'fractional') {
      return formatFractional(decimal);
    }

    return formatDecimal(decimal);
  }

  function formatOddsValue(value, format = getFormat()) {
    const decimal = parseDecimalOdds(value);
    return decimal ? formatDecimalOdds(decimal, format) : String(value || '-');
  }

  function applyOddsFormatting(root = document) {
    const format = getFormat();
    const scope = root || document;

    document.documentElement.dataset.oddsFormat = format;

    scope.querySelectorAll('[data-decimal-odds]').forEach((element) => {
      const decimal = parseDecimalOdds(element.dataset.decimalOdds || element.textContent);

      if (!decimal) {
        return;
      }

      element.textContent = formatDecimalOdds(decimal, format);
      element.dataset.oddsFormat = format;
      element.title = `Decimal ${formatDecimal(decimal)} / American ${formatAmerican(decimal)} / Fractional ${formatFractional(decimal)}`;
    });
  }

  window.LivePicksOdds = {
    apply: applyOddsFormatting,
    formatDecimalOdds,
    formatOddsValue,
    getAutoFormat,
    getFormat,
    getSavedFormat,
    parseDecimalOdds,
    setFormat
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => applyOddsFormatting(document));
  } else {
    applyOddsFormatting(document);
  }
}());
