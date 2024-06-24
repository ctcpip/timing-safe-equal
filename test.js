var assert = require('assert');
var test = require('tape');
var timingSafeEqual = require('./browser')

// ad hoc polyfill buffer.from
if (!Buffer.from) {
  Buffer.from = function(value) {
    return new Buffer(value);
  }
}

// ad hoc polyfill buffer.alloc
if (!Buffer.alloc) {
  Buffer.alloc = function(size, fill) {
    var buffer = Buffer.from(size);
    buffer.fill(fill);
    return buffer;
  };
}

// ad hoc polyfill buffer.equals
if (typeof Buffer.prototype.equals !== 'function') {
  Buffer.prototype.equals = function (buffer) {
    if (this.length !== buffer.length) {
      return false;
    }
    for (var i = 0; i < this.length; i++) {
      if (this[i] !== buffer[i]) {
        return false;
      }
    }
    return true;
  };
}

test('generic', function (t) {
  t.plan(5);
  t.strictEqual(
    timingSafeEqual(Buffer.from('foo'), Buffer.from('foo')),
    true,
    'should consider equal strings to be equal'
  );

  t.strictEqual(
    timingSafeEqual(Buffer.from('foo'), Buffer.from('bar')),
    false,
    'should consider unequal strings to be unequal'
  );

  t.throws(function() {
    timingSafeEqual(Buffer.from([1, 2, 3]), Buffer.from([1, 2]));
  }, 'should throw when given buffers with different lengths');

  t.throws(function() {
    timingSafeEqual('not a buffer', Buffer.from([1, 2]));
  }, 'should throw if the first argument is not a buffer');

  t.throws(function() {
    timingSafeEqual(Buffer.from([1, 2]), 'not a buffer');
  }, 'should throw if the second argument is not a buffer');
});
test('benchmarking', function (t) {
  t.plan(2)
  // t_(0.99995, ∞)
  // i.e. If a given comparison function is indeed timing-safe, the t-test result
  // has a 99.99% chance to be below this threshold. Unfortunately, this means
  // that this test will be a bit flakey and will fail 0.01% of the time even if
  // crypto.timingSafeEqual is working properly.
  // t-table ref: http://www.sjsu.edu/faculty/gerstman/StatPrimer/t-table.pdf
  // Note that in reality there are roughly `2 * numTrials - 2` degrees of
  // freedom, not ∞. However, assuming `numTrials` is large, this doesn't
  // significantly affect the threshold.
  var T_THRESHOLD = 3.892;

  var tv = getTValue(timingSafeEqual);
  t.ok(
    Math.abs(tv) < T_THRESHOLD,
    'timingSafeEqual should not leak information from its execution time (t=' + tv + ')'
  );

  // As a sanity check to make sure the statistical tests are working, run the
  // same benchmarks again, this time with an unsafe comparison function. In this
  // case the t-value should be above the threshold.
  var unsafeCompare = function (bufA, bufB) { return bufA.equals(bufB); };
  var t2 = getTValue(unsafeCompare);
  t.ok(
    Math.abs(t2) > T_THRESHOLD,
    'Buffer#equals should leak information from its execution time (t=' + t2 + ')'
  );
});
function getTValue(compareFunc) {
  var numTrials = 10000;
  var testBufferSize = 10000;
  // Perform benchmarks to verify that timingSafeEqual is actually timing-safe.

  var rawEqualBenches = Array(numTrials);
  var rawUnequalBenches = Array(numTrials);

  for (var i = 0; i < numTrials; i++) {

    // The `runEqualBenchmark` and `runUnequalBenchmark` functions are
    // intentionally redefined on every iteration of this loop, to avoid
    // timing inconsistency.
    function runEqualBenchmark(compareFunc, bufferA, bufferB) {
      var startTime = process.hrtime();
      var result = compareFunc(bufferA, bufferB);
      var endTime = process.hrtime(startTime);

      // Ensure that the result of the function call gets used, so it doesn't
      // get discarded due to engine optimizations.
      assert.strictEqual(result, true);
      return endTime[0] * 1e9 + endTime[1];
    }

    // This is almost the same as the runEqualBenchmark function, but it's
    // duplicated to avoid timing issues with V8 optimization/inlining.
    function runUnequalBenchmark(compareFunc, bufferA, bufferB) {
      var startTime = process.hrtime();
      var result = compareFunc(bufferA, bufferB);
      var endTime = process.hrtime(startTime);

      assert.strictEqual(result, false);
      return endTime[0] * 1e9 + endTime[1];
    }

    if (i % 2) {
      var bufferA1 = Buffer.alloc(testBufferSize, 'A');
      var bufferB = Buffer.alloc(testBufferSize, 'B');
      var bufferA2 = Buffer.alloc(testBufferSize, 'A');
      var bufferC = Buffer.alloc(testBufferSize, 'C');

      // First benchmark: comparing two equal buffers
      rawEqualBenches[i] = runEqualBenchmark(compareFunc, bufferA1, bufferA2);

      // Second benchmark: comparing two unequal buffers
      rawUnequalBenches[i] = runUnequalBenchmark(compareFunc, bufferB, bufferC);
    } else {
      // Swap the order of the benchmarks every second iteration, to avoid any
      // patterns caused by memory usage.
      var bufferB = Buffer.alloc(testBufferSize, 'B');
      var bufferA1 = Buffer.alloc(testBufferSize, 'A');
      var bufferC = Buffer.alloc(testBufferSize, 'C');
      var bufferA2 = Buffer.alloc(testBufferSize, 'A');
      rawUnequalBenches[i] = runUnequalBenchmark(compareFunc, bufferB, bufferC);
      rawEqualBenches[i] = runEqualBenchmark(compareFunc, bufferA1, bufferA2);
    }
  }

  var equalBenches = filterOutliers(rawEqualBenches);
  var unequalBenches = filterOutliers(rawUnequalBenches);

  // Use a two-sample t-test to determine whether the timing difference between
  // the benchmarks is statistically significant.
  // https://wikipedia.org/wiki/Student%27s_t-test#Independent_two-sample_t-test

  var equalMean = mean(equalBenches);
  var unequalMean = mean(unequalBenches);

  var equalLen = equalBenches.length;
  var unequalLen = unequalBenches.length;

  var combinedStd = combinedStandardDeviation(equalBenches, unequalBenches);
  var standardErr = combinedStd * Math.sqrt(1 / equalLen + 1 / unequalLen);

  return (equalMean - unequalMean) / standardErr;
}

// Returns the mean of an array
function mean(array) {
  return array.reduce(function (sum, val) { return sum + val }, 0) / array.length;
}

// Returns the sample standard deviation of an array
function standardDeviation(array) {
  var arrMean = mean(array);
  var total = array.reduce(function (sum, val) { return sum + Math.pow(val - arrMean, 2) }, 0);
  return Math.sqrt(total / (array.length - 1));
}

// Returns the common standard deviation of two arrays
function combinedStandardDeviation(array1, array2) {
  var sum1 = Math.pow(standardDeviation(array1), 2) * (array1.length - 1);
  var sum2 = Math.pow(standardDeviation(array2), 2) * (array2.length - 1);
  return Math.sqrt((sum1 + sum2) / (array1.length + array2.length - 2));
}

// Filter large outliers from an array. A 'large outlier' is a value that is at
// least 50 times larger than the mean. This prevents the tests from failing
// due to the standard deviation increase when a function unexpectedly takes
// a very long time to execute.
function filterOutliers(array) {
  var arrMean = mean(array);
  return array.filter(function (value) { return value / arrMean < 50 });
}
