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
        modulusLength: 4096,
        publicKeyEncoding: {
          type: 'spki',
          format: 'pem',
        },
        privateKeyEncoding: {
          type: 'pkcs8',
          format: 'pem',
        },
      }, (err, privateKey, publicKey) => {
        if (err) return reject(err);
        const parsedPrivateKey = utils.parseKey(privateKey);
        const openSshPublicKey = parsedPrivateKey.public.toString('ssh'); // This gives the 'ssh-rsa AAAA...' format
        resolve({ privateKey, publicKey: openSshPublicKey });
      });
    });
  }

  async onPair(session) {
    let discovered = [];

    session.setHandler('manual_login', async (conSett) => {
      try {
        this.log(conSett);
        const settings = { ...conSett };

        // 1. Generate SSH key pair
        this.log('Generating SSH key pair...');
        const { privateKey, publicKey } = await this.generateSshKeyPair();

        // 2. Attempt initial connection using password to deploy public key
        const tempRpi = new RPI({
          host: settings.host,
          port: settings.port,
          username: settings.username,
          password: settings.password, // Use password for initial connection
        });
        await tempRpi.connect();

        // 3. Deploy public key to RPi's authorized_keys
        this.log('Deploying public key to Raspberry Pi...');
        // Ensure .ssh directory exists and has correct permissions, then append key
        const deployCommand = `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo "${publicKey}" >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`;
        await tempRpi.execute(deployCommand);
        await tempRpi.disconnect(); // Disconnect the temporary password-based connection

        // 4. Store private key in settings and remove password for future connections
        settings.privateKey = privateKey;
        delete settings.password; // Remove password from stored settings

        // 5. Connect using the new private key and get system info
        const rpi = new RPI(settings); // Re-initialize RPI with key-based settings
        await rpi.connect(); // Connect using the private key
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
      return discovered;
    });

    session.setHandler('list_devices', async () => {
      return discovered;
    });
  }

}

module.exports = RPiDriver;
