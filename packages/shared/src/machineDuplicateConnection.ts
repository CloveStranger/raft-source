/**
 * Task #374: the server closes the older of two live connections that use the
 * same machine key, and refuses a new one while the winner is alive. The
 * daemon reads the reason: after being closed as the duplicate it backs off
 * for a long time; a refusal while the winner holds the key uses the normal
 * reconnect backoff, so a winner that only lost its own socket comes back
 * within the hold window.
 */
export const MACHINE_DUPLICATE_CONNECTION_CLOSE_CODE = 4003;
/** This connection was the older of two live connections for the machine key and was closed. */
export const MACHINE_DUPLICATE_CONNECTION_CLOSE_REASON = "duplicate_machine_connection";
/** This connection was refused because another live connection holds the machine key. */
export const MACHINE_DUPLICATE_CONNECTION_HELD_CLOSE_REASON = "duplicate_machine_connection_held";
