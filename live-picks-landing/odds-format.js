(function () {
  const STORAGE_KEY = 'livePicksOddsFormat';
  const VALID_FORMATS = new Set(['decimal', 'american', 'fractional']);
  const FRACTIONAL_REGIONS = new Set(['GB', 'IE']);
  const AMERICAN_REGIONS = new Set(['US', 'CA']);

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

  function approximateFraction(value, maxDenominator = 100) {
    let bestNumerator = 1;
    let bestDenominator = 1;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let denominator = 1; denominator <= maxDenominator; denominator += 1) {
      const numerator = Math.round(value * denominator);
      const distance = Math.abs(value - numerator / denominator);

      if (distance < bestDistance) {
        bestDistance = distance;
        bestNumerator = Math.max(numerator, 1);
        bestDenominator = denominator;
      }
    }

    const divisor = gcd(bestNumerator, bestDenominator);

    return {
      numerator: bestNumerator / divisor,
      denominator: bestDenominator / divisor
    };
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
    const fraction = approximateFraction(decimal - 1);
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
