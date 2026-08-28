## DGLAB

DG-LAB is a popular hardware brand specializing in dual-channel electro-stimulation (e-stim) pulse generators. These devices deliver precise electrical pulses through two independent channels (Output A and Output B), allowing users to control parameters like power level, pulse frequency, pulse width, and waveform patterns.

- **The Hardware:** Hardware units (such as Coyote V2 and V3) generate localized electrical pulses.
- **Dual-Channel Control:** Allows independent adjustment of intensity, waveform curves, and strength for two separate outputs simultaneously.
- **Connectivity:** Devices connect via **Bluetooth Low Energy (BLE)** to smartphone apps or PC controls, enabling real-time remote manipulation.
- **Use Cases:** Beyond standard app control, the hardware is frequently integrated into custom interactive experiences—such as linking pulse triggers to games, audio streams, or interactive hardware.

## DGLAB SDK

[dglab-kit](https://github.com/dungeonlab-open/dglab-kit)

It abstracts away the low-level communication protocols so developers can build custom software that interacts with DG-LAB devices.

1. **High-Level Abstraction:**
   Rather than manually constructing raw BLE hex payloads or dealing with low-level socket connections, the SDK provides clean, event-driven methods to discover, pair, and send pulse data to devices.
2. **Communication Modes:**

- **Direct BLE (WebBluetooth / Node BLE):** Connect directly to a DG-LAB device via a local computer or browser.
- **WebSocket Protocol:** Connect to the official DG-LAB WebSocket server (or self-hosted instances). This allows remote control over the internet via the DG-LAB mobile app bridge without requiring direct Bluetooth hardware on your development machine.

3. **Core Capabilities in Code:**

- **Intensity & Limit Control:** Adjust power output step-by-step or set safe ceiling limits dynamically.
- **Waveform Generation:** Send custom pulse sequences, custom duty cycles, and real-time pulse data to channels A and B.
- **Status & Telemetry:** Listen to battery levels, connection status, and real-time output feedback.
