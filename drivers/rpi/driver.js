/*
Copyright 2024 -2026, Robin de Gruijter (gruijter@hotmail.com)

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

'use strict';

const { Driver } = require('homey');
const crypto = require('crypto');
const { utils } = require('ssh2'); // For parsing keys to OpenSSH format
const RPI = require('../../lib/rpi_ssh');

const capabilities = [
  'measure_temperature.gpu',
  'measure_temperature.cpu',
  'meter_cpu_utilization',
  'meter_cpu_scaling',
  'meter_mem_utilization',
  'meter_storage_utilization',
  'meter_processes.active',
  'meter_processes.running',
  'uptime',
  'meter_users',
  'meter_download_speed.eth0',
  'meter_upload_speed.eth0',
  'meter_download_speed.wlan0',
  'meter_upload_speed.wlan0',
  'onoff.gpio0',
  'button.gpio0',
  'onoff.gpio1',
  'button.gpio1',
  'onoff.gpio2',
  'button.gpio2',
  'onoff.gpio3',
  'button.gpio3',
  'onoff.gpio4',
  'button.gpio4',
  'onoff.gpio5',
  'button.gpio5',
  'onoff.gpio6',
  'button.gpio6',
  'onoff.gpio7',
  'button.gpio7',
  'onoff.gpio8',
  'button.gpio8',
  'onoff.gpio9',
  'button.gpio9',
  'onoff.gpio10',
  'button.gpio10',
  'onoff.gpio11',
  'button.gpio11',
  'onoff.gpio12',
  'button.gpio12',
  'onoff.gpio13',
  'button.gpio13',
  'onoff.gpio14',
  'button.gpio14',
  'onoff.gpio15',
  'button.gpio15',
];

class RPiDriver extends Driver {

  async onInit() {
    this.ds = { capabilities };
    this.log('RPi driver has been initialized');
  }

  // // MAC discovery related stuff
  // async discover() {
  //   const discoveryStrategy = this.getDiscoveryStrategy();
  //   const discoveryResults = await discoveryStrategy.getDiscoveryResults();
  //   console.dir(discoveryResults, { depth: null });
  // }

  /**
   * Generates an RSA SSH key pair (private and public).
   * The public key is returned in OpenSSH format suitable for authorized_keys.
   * @returns {Promise<{privateKey: string, publicKey: string}>}
   */
  async generateSshKeyPair() {
    return new Promise((resolve, reject) => {
      crypto.generateKeyPair('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: {
          type: 'spki',
          format: 'pem',
        },
        privateKeyEncoding: {
          type: 'pkcs8',
          format: 'pem',
        },
      }, (err, _publicKey, privateKey) => {
        if (err) {
          reject(err);
        } else {
          const parsedKey = utils.parseKey(privateKey);
          const openSshPublicKey = parsedKey.public.toString('ssh');
          const publicKeyWithComment = `${openSshPublicKey} com.gruijter.rpi`;
          resolve({ privateKey, publicKey: publicKeyWithComment });
        }
      });
    });
  }

  /**
   * Constructs the shell command to deploy the SSH public key.
   * This command ensures the .ssh directory and authorized_keys file exist,
   * removes any previous key from this app, and appends the new key.
   * @param {string} publicKey - The public key to deploy.
   * @returns {string} The full shell command.
   */
  getDeployCommand(publicKey) {
    const commands = [
      'mkdir -p ~/.ssh',
      'chmod 700 ~/.ssh',
      'touch ~/.ssh/authorized_keys',
      "sed -i '/com.gruijter.rpi/d' ~/.ssh/authorized_keys",
      `echo "${publicKey}" >> ~/.ssh/authorized_keys`,
      'chmod 600 ~/.ssh/authorized_keys',
    ];
    return commands.join(' && ');
  }

  async onPair(session) {
    let discovered = [];

    // Pre-generate the SSH key pair as soon as the pairing session starts
    // to minimize waiting time for the user later on.
    this.log('Pre-generating SSH key pair for pairing session...');
    const keyPairPromise = this.generateSshKeyPair();
    keyPairPromise.catch((err) => this.error('Background SSH key generation failed:', err));

    session.setHandler('manual_login', async (conSett) => {
      try {
        this.log(conSett);
        const settings = { ...conSett };

        // 1. Retrieve the pre-generated SSH key pair (or wait if it's still generating)
        this.log('Retrieving SSH key pair...');
        const { privateKey, publicKey } = await keyPairPromise;

        // 2. Attempt initial connection using password to deploy public key
        const tempRpi = new RPI({
          host: settings.host,
          port: settings.port,
          username: settings.username,
          password: settings.password, // Use password for initial connection
        });
        await tempRpi.connect();

        let keyDeployed = false;
        try {
          // 3. Deploy public key to RPi's authorized_keys
          this.log('Deploying public key to Raspberry Pi...');
          const deployCommand = this.getDeployCommand(publicKey);
          await tempRpi.execute(deployCommand);
          keyDeployed = true;
        } catch (deployError) {
          this.error('Key deployment failed:', deployError);
        } finally {
          await tempRpi.disconnect(); // Disconnect the temporary password-based connection
        }

        let warningMsg = null;
        if (keyDeployed) {
          // 4. Store private key in settings and remove password for future connections
          settings.privateKey = privateKey;
          delete settings.password; // Remove password from stored settings
        } else {
          warningMsg = 'SSH key deployment failed. The username and password will be stored and used for authentication instead.';
          settings.privateKey = null;
        }

        // 5. Connect using the new settings and get system info
        const rpi = new RPI(settings); // Re-initialize RPI with the updated settings
        await rpi.connect(); // Connect using the configured method
        const sysInfo = await rpi.getSysInfo();
        Object.entries(sysInfo).forEach((entry) => {
          if (entry[1]) settings[entry[0]] = entry[1].toString();
        });
        const device = {
          name: `${sysInfo.hostName}`,
          data: {
            id: sysInfo.serial,
          },
          capabilities,
          settings, // These settings now contain the privateKey and no password
        };
        discovered = [device];
        return { warning: warningMsg };
      } catch (error) {
        this.error(error);
        // Provide more user-friendly feedback during pairing
        if (error.level === 'client-authentication' || error.message.includes('All configured authentication methods failed')) {
          throw new Error('Authentication failed. Please check the username and password.');
        }
        if (error.level === 'client-socket') {
          throw new Error(`Could not connect to the host. Please check the IP address and network connection. (${error.message})`);
        }
        if (error.message.includes('permission denied')) {
          throw new Error('Failed to deploy SSH key. The user may not have permission to write to their home directory on the RPi.');
        }
        // Generic fallback for other errors
        throw new Error(`An unexpected error occurred: ${error.message}`);
      }
    });

    session.setHandler('list_devices', async () => discovered);
  }

  async onRepair(session, device) {
    this.log(`Repairing device: ${device.getName()}`);

    // Pre-generate a new SSH key pair for the repair process.
    this.log('Pre-generating new SSH key pair for repair...');
    const keyPairPromise = this.generateSshKeyPair();
    keyPairPromise.catch((err) => this.error('Background SSH key generation for repair failed:', err));

    session.setHandler('get_device_data', async () => {
      const settings = device.getSettings();
      return {
        host: settings.host,
        port: settings.port,
        username: settings.username,
      };
    });

    session.setHandler('manual_login', async (conSett) => {
      try {
        this.log('Repair manual_login data:', conSett);
        const settings = { ...conSett };

        // 1. Retrieve the pre-generated SSH key pair
        this.log('Retrieving new SSH key pair for repair...');
        const { privateKey, publicKey } = await keyPairPromise;

        // 2. Attempt connection using password to deploy the new public key
        const tempRpi = new RPI({
          host: settings.host,
          port: settings.port,
          username: settings.username,
          password: settings.password,
        });
        await tempRpi.connect();

        let keyDeployed = false;
        try {
          // 3. Deploy the new public key, removing any old key from this app
          this.log('Deploying new public key to Raspberry Pi...');
          const deployCommand = this.getDeployCommand(publicKey);
          await tempRpi.execute(deployCommand);
          keyDeployed = true;
        } catch (deployError) {
          this.error('Key deployment failed:', deployError);
        } finally {
          await tempRpi.disconnect();
        }

        let warningMsg = null;
        if (keyDeployed) {
          // 4. Update device settings with the new private key and connection info
          settings.privateKey = privateKey;
          delete settings.password;
        } else {
          warningMsg = 'SSH key deployment failed. The username and password will be stored and used for authentication instead.';
          settings.privateKey = null;
        }

        // 5. Connect with the new key to verify and get updated sysInfo
        const rpi = new RPI(settings);
        await rpi.connect();
        const sysInfo = await rpi.getSysInfo();
        Object.entries(sysInfo).forEach((entry) => {
          if (entry[1]) settings[entry[0]] = entry[1].toString();
        });

        // 6. Update the device's settings. This will trigger a restart of the device instance.
        await device.setSettings(settings);

        return { warning: warningMsg }; // Indicate success and optional warning to the frontend
      } catch (error) {
        this.error('Repair failed:', error);
        if (error.level === 'client-authentication' || error.message.includes('All configured authentication methods failed')) {
          throw new Error('Authentication failed. Please check the username and password.');
        }
        if (error.level === 'client-socket') {
          throw new Error(`Could not connect to the host. Please check the IP address and network connection. (${error.message})`);
        }
        if (error.message.includes('permission denied')) {
          throw new Error('Failed to deploy SSH key. The user may not have permission to write to their home directory on the RPi.');
        }
        throw new Error(`An unexpected error occurred during repair: ${error.message}`);
      }
    });
  }

}

module.exports = RPiDriver;
