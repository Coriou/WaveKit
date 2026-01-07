import { createServer, createConnection, Socket, Server } from 'node:net';
import { EventEmitter } from 'node:events';
import { type Logger } from '../utils/logger.js';

/**
 * PassiveRtlProxy - A TCP proxy that strips RTL-TCP control commands.
 * 
 * This proxy sits between a decoder (client) and the real RTL-TCP server.
 * It forwards IQ data from server to client (downstream) unchanged.
 * It intercepts and DROPS control commands from client to server (upstream)
 * to prevent the decoder from retuning the radio or changing sample rates.
 */
export class PassiveRtlProxy extends EventEmitter {
    private server: Server;
    private realHost: string;
    private realPort: number;
    private logger: Logger;
    private port: number = 0; // Assigned ephemeral port

    constructor(realHost: string, realPort: number, logger: Logger) {
        super();
        this.realHost = realHost;
        this.realPort = realPort;
        this.logger = logger;

        this.server = createServer((clientSocket) => {
            this.handleConnection(clientSocket);
        });
    }

    /**
     * Starts the proxy server on an ephemeral port.
     * @returns The port number the proxy is listening on.
     */
    async listen(): Promise<number> {
        return new Promise((resolve, reject) => {
            this.server.listen(0, '127.0.0.1', () => {
                const addr = this.server.address();
                if (addr && typeof addr !== 'string') {
                    this.port = addr.port;
                    this.logger.info({ port: this.port, upstream: `${this.realHost}:${this.realPort}` }, 'Passive RTL Proxy started');
                    resolve(this.port);
                } else {
                    reject(new Error('Failed to get proxy port'));
                }
            });

            this.server.on('error', (err) => {
                reject(err);
            });
        });
    }

    /**
     * Stops the proxy server.
     */
    close(): void {
        this.server.close();
        this.logger.info('Passive RTL Proxy stopped');
    }

    private handleConnection(clientSocket: Socket) {
        this.logger.debug('Decoder connected to Passive Proxy');

        // Connect to the real RTL-TCP server
        const upstreamSocket = createConnection({ host: this.realHost, port: this.realPort }, () => {
            this.logger.debug('Proxy connected to upstream RTL-TCP');
        });

        // Downstream: Server -> Client (Forward everything, mostly IQ data)
        upstreamSocket.pipe(clientSocket);

        // Upstream: Client -> Server (Filter control commands)
        clientSocket.on('data', (data) => {
            // RTL-TCP commands are typically 5 bytes: [Command ID, Param1, Param2, Param3, Param4]
            // We want to block commands that affect tuning.
            
            // Command IDs (from rtl_tcp source):
            // 0x01: Set Frequency
            // 0x02: Set Sample Rate
            // 0x03: Set Gain Mode
            // 0x04: Set Gain
            // 0x05: Set Frequency Correction
            // 0x08: Set AGC
            
            // We'll filter based on the command byte (first byte of packet).
            // Since packets can be concatenated, we should technically parse properly, 
            // but for a lightweight proxy, checking chunks might be risky if boundaries don't align.
            // However, control commands are rare and usually sent individually at start.
            
            // For now, let's aggressively drop EVERYTHING from client to server. 
            // Passive decoders shouldn't need to send anything except maybe an initial handshake?
            // rtl_tcp protocol doesn't require a client handshake to start streaming.
            // As soon as you connect, it sends the Dongle Info header, then waits for commands? 
            // No, usually it waits for a command to start?
            // Actually, rtl_tcp starts streaming immediately? No, it often waits for Set Freq/Rate.
            
            // Wait, if we drop EVERYTHING, the decoder might hang if it expects to set freq before receiving.
            // But if the server is ALREADY streaming (because SDR++ or another client started it), 
            // then we just need to tap into the stream.
            // `rtlmux` specifically is designed to multiplex.
            
            // The safest "Passive" approach is to transmit NOTHING upstream.
            // If the decoder sends a "Set Freq" and doesn't get data, it might retry.
            // But `rtlmux` should be sending data regardless if there is an active master.
            
            this.logger.debug({ length: data.length, hex: data.toString('hex') }, 'Blocked upstream control packet');
        });

        upstreamSocket.on('error', (err) => {
            this.logger.error({ err }, 'Upstream connection error');
            clientSocket.destroy();
        });

        clientSocket.on('error', (err) => {
            this.logger.error({ err }, 'Client connection error');
            upstreamSocket.destroy();
        });

        clientSocket.on('close', () => {
            upstreamSocket.destroy();
        });
        
        upstreamSocket.on('close', () => {
            clientSocket.destroy();
        });
    }
}
