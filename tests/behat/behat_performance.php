<?php
// This file is part of Moodle - http://moodle.org/
//
// Moodle is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// Moodle is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with Moodle.  If not, see <http://www.gnu.org/licenses/>.

use Behat\Mink\Exception\DriverException;
use Behat\Mink\Exception\ExpectationException;

require_once(__DIR__ . '/../../../../lib/behat/behat_base.php');
require_once(__DIR__ . '/classes/measure_timing.php');

/**
 * Behat step definitions to measure performance.
 */
class behat_performance extends behat_base {

    /**
     * @var array
     */
    private $timings = [];

    /**
     * Start timing a performance measure.
     *
     * @When /^I start timing "([^"]+)"$/
     */
    public function i_start_timing(string $measure) {
        $this->timings[$measure] = new measure_timing($measure);
        $this->timings[$measure]->start();
    }

    /**
     * Stop timing a performance measure.
     *
     * @When /^I stop timing "([^"]+)"$/
     */
    public function i_stop_timing(string $measure) {
        $this->get_measure_timing($measure)->end();
    }

    /**
     * Assert how long a performance measure took.
     *
     * @Then /^"([^"]+)" should have taken (less than|more than|exactly) (\d+(?:\.\d+)? (?:seconds|milliseconds))$/
     */
    public function timing_should_have_taken(string $measure, Closure $comparison, float $expectedtime) {
        $measuretiming = $this->get_measure_timing($measure);

        if (!call_user_func($comparison, $measuretiming->duration, $expectedtime)) {
            throw new ExpectationException(
                "Expected timing for '$measure' measure failed! (took {$measuretiming->duration}ms)",
                $this->getSession()->getDriver()
            );
        }

        $measuretiming->store();
    }

    /**
     * Parse time.
     *
     * @Transform /^\d+(?:\.\d+)? (?:seconds|milliseconds)$/
     * @param string $text Time string.
     * @return float
     */
    public function parse_time(string $text): float {
        $spaceindex = strpos($text, ' ');
        $value = floatval(substr($text, 0, $spaceindex));

        switch (substr($text, $spaceindex + 1)) {
            case 'seconds':
                $value *= 1000;
                break;
        }

        return $value;
    }

    /**
     * Parse a comparison function.
     *
     * @Transform /^less than|more than|exactly$/
     * @param string $text Comparison string.
     * @return Closure
     */
    public function parse_comparison(string $text): Closure {
        switch ($text) {
            case 'less than':
                return function ($a, $b) {
                    return $a < $b;
                };
            case 'more than':
                return function ($a, $b) {
                    return $a > $b;
                };
            case 'exactly':
                return function ($a, $b) {
                    return $a === $b;
                };
        }
    }

    /**
     * Get measure timing by name.
     *
     * @param string $measure Measure timing name.
     * @return measure_timing Measure timing.
     */
    private function get_measure_timing(string $measure): measure_timing {
        if (!isset($this->timings[$measure])) {
            throw new DriverException("Timing for '$measure' measure does not exist.");
        }

        return $this->timings[$measure];
    }

}