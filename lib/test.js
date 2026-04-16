/*
Copyright 2024 - 2026, Robin de Gruijter (gruijter@hotmail.com)

This file is part of com.gruijter.rpi.

com.gruijter.rpi is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

com.gruijter.rpi is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with com.gruijter.rpi. If not, see <http://www.gnu.org/licenses/>.
*/

/* eslint-disable no-console */
/*
This is a test script for the RPi SSH library (lib/rpi_ssh.js).
It runs through most of the available functions to check for errors and validate output.

HOW TO USE:
1. Fill in your Raspberry Pi's connection details in the `CONNECTION_SETTINGS` object below.
2. (Optional) Change the `TEST_GPIO_PIN` and `TEST_CONTAINER_NAME` to valid values for your system.
3. (Optional) To test dangerous commands, set `RUN_DESTRUCTIVE_TESTS` to `true`.
4. Run the script from your terminal: `node test.js`
*/

'use strict';

const RPI = require('./rpi_ssh');

// --- START CONFIGURATION ---

const CONNECTION_SETTINGS = {
  host: '192.168.0.XX', // <-- IMPORTANT: SET YOUR RPI's IP ADDRESS
  username: 'pi', // <-- Set your username
  password: 'your_password', // <-- Set your password
};

const TEST_GPIO_PIN = 21; // IMPORTANT: Change to a safe, unused GPIO pin for testing
const TEST_CONTAINER_NAME = 'portainer'; // IMPORTANT: Change to a container name that exists on your RPi

// WARNING: Enabling this will run commands that update, reboot, or power off your Raspberry Pi!
const RUN_DESTRUCTIVE_TESTS = false;

// --- END CONFIGURATION ---

/**
 * Helper to run a test and log its status.
 * @param {string} name - The name of the test.
 * @param {Function} testFn - An async function that performs the test.
 */
async function runTest(name, testFn) {
  console.log(`\n--- Running test: ${name} ---`);
  try {
    const result = await testFn();
    console.log(`[SUCCESS] ${name}`);
    if (result !== undefined && result !== true) {
      console.log('Result:', JSON.stringify(result, null, 2));
    }
    return true;
  } catch (error) {
    console.error(`[FAILURE] ${name}`);
    console.error('Error:', error.message);
    return false;
  }
}

async function main() {
  console.log('Starting RPi SSH Library Test Suite...');

  if (CONNECTION_SETTINGS.host === '192.168.0.XX' || CONNECTION_SETTINGS.password === 'your_password') {
    console.error('\nERROR: Please configure your connection settings in test.js before running.');
    return;
  }

  const rpi = new RPI(CONNECTION_SETTINGS);

  // --- Test Execution ---

  const tests = [
    { name: 'Connect', fn: () => rpi.connect() },
    { name: 'Get System Info', fn: () => rpi.getSysInfo() },
    { name: 'Get System Stats', fn: () => rpi.getStats() },
    { name: 'Get Last Logins', fn: () => rpi.getLastLogin() },
    { name: 'Get Active Users', fn: () => rpi.getUsers() },
    { name: 'Get GPIO States', fn: () => rpi.getGPIOStates() },
    { name: 'Get Docker Containers', fn: () => rpi.getContainers() },
    { name: 'Execute command (`echo "Hello"`)', fn: () => rpi.execute('echo "Hello from Homey"') },
    { name: 'Silent Execute (failing command)', fn: () => rpi.silentExec('this_command_will_fail_silently') },
    {
      name: 'Find Logs Delta (mock data)',
      fn: () => {
        const mockOldLogs = [{
          user: 'pi', loginTime: '2024-08-01T10:00:00+02:00', logoutTime: null, info: 'still logged in',
        }];
        const mockNewLogs = [
          {
            user: 'pi', loginTime: '2024-08-01T10:00:00+02:00', logoutTime: '2024-08-01T11:00:00+02:00', info: '',
          },
          {
            user: 'test', loginTime: '2024-08-01T10:30:00+02:00', logoutTime: null, info: 'still logged in',
          },
        ];
        rpi.oldLogs = mockOldLogs; // Manually set old state for test
        return rpi.findLogsDelta(mockNewLogs);
      },
    },
    // GPIO Functionality
    { name: `Set GPIO ${TEST_GPIO_PIN} function to OUTPUT`, fn: () => rpi.setGPIOFunction({ io: TEST_GPIO_PIN, output: true }) },
    { name: `Set GPIO ${TEST_GPIO_PIN} state to HIGH`, fn: () => rpi.setGPIOState({ io: TEST_GPIO_PIN, high: true }) },
    { name: `Set GPIO ${TEST_GPIO_PIN} state to LOW`, fn: () => rpi.setGPIOState({ io: TEST_GPIO_PIN, high: false }) },
    { name: `Set GPIO ${TEST_GPIO_PIN} function to INPUT`, fn: () => rpi.setGPIOFunction({ io: TEST_GPIO_PIN, output: false }) },
    // Docker Functionality
    { name: `Start Container ('${TEST_CONTAINER_NAME}')`, fn: () => rpi.startContainer(TEST_CONTAINER_NAME) },
    { name: `Restart Container ('${TEST_CONTAINER_NAME}')`, fn: () => rpi.restartContainer(TEST_CONTAINER_NAME) },
    { name: `Stop Container ('${TEST_CONTAINER_NAME}')`, fn: () => rpi.stopContainer(TEST_CONTAINER_NAME) },
    // Start it again to leave it in a running state
    { name: `Start Container ('${TEST_CONTAINER_NAME}') again`, fn: () => rpi.startContainer(TEST_CONTAINER_NAME) },
  ];

  for (const test of tests) {
    const success = await runTest(test.name, test.fn);
    if (!success && test.name === 'Connect') {
      console.error('Connection test failed. Aborting further tests.');
      break;
    }
  }

  // Destructive Tests
  if (RUN_DESTRUCTIVE_TESTS) {
    console.log('\n--- WARNING: RUNNING DESTRUCTIVE TESTS ---');

    // Note: The 'update' command can take a long time and may time out.
    const updateTest = await runTest('OS Update', () => rpi.update());
    if (!updateTest) {
      console.log('Update test failed, skipping reboot and poweroff for safety.');
    } else {
      // These tests will disconnect the script. Only run one.
      // await runTest('Reboot', () => rpi.reboot());
      // await runTest('Power Off', () => rpi.poweroff());
    }
  } else {
    console.log('\nSkipping destructive tests (update, reboot, poweroff). Set RUN_DESTRUCTIVE_TESTS to true to enable.');
  }

  await runTest('Disconnect', () => rpi.disconnect());

  console.log('\nTest Suite Finished.');
}

main().catch((err) => {
  console.error('\nAn unexpected error occurred during the test suite:', err);
});
