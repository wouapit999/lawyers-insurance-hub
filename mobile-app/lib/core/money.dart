/// XAF money handling for the mobile client.
///
/// Mirrors packages/domain/src/money/xaf.ts exactly, and for the same reason:
/// XAF has no minor unit, so an amount is a whole number of francs. Dart's
/// `int` is 64-bit on mobile targets, which covers every amount this system
/// will ever hold, so `int` is the right carrier — `double` is not.
///
/// The formatting must produce byte-identical output to the server, because
/// the same premium appears on the API's PDF certificate and on this screen.
/// A user who sees "285 000 XAF" in one place and "285,000.00 XAF" in another
/// reasonably wonders which is real.
library;

class Xaf {
  const Xaf._();

  /// Narrow no-break space (U+202F) — pinned, matching GROUP_SEPARATOR in the
  /// domain package rather than relying on Intl, whose separator for fr_CM
  /// differs between ICU versions.
  static const String groupSeparator = ' ';

  /// Parse an amount as the API sends it: a decimal string, never a number.
  static int parse(dynamic value) {
    if (value is int) return value;
    if (value is String) {
      final whole = value.split('.').first;
      return int.parse(whole);
    }
    throw FormatException('Not an XAF amount: $value');
  }

  /// Format for display: "285 000 XAF".
  static String format(int amount, {bool withCurrency = true}) {
    final negative = amount < 0;
    final digits = amount.abs().toString();

    final buffer = StringBuffer();
    for (var i = 0; i < digits.length; i++) {
      if (i > 0 && (digits.length - i) % 3 == 0) buffer.write(groupSeparator);
      buffer.write(digits[i]);
    }

    final body = '${negative ? '-' : ''}$buffer';
    return withCurrency ? '$body XAF' : body;
  }

  /// Split a premium into installments that sum back exactly.
  ///
  /// Same remainder rule as the server: the extra francs go to the earliest
  /// installments. The client only ever displays this — the server's schedule
  /// is authoritative — but the two must agree or the preview misleads.
  static List<int> splitEvenly(int amount, int parts) {
    if (parts < 1) throw ArgumentError('parts must be >= 1');
    final base = amount ~/ parts;
    final remainder = amount - base * parts;
    return List<int>.generate(parts, (i) => i < remainder ? base + 1 : base);
  }
}
