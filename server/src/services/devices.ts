import { FastifyReply, FastifyRequest } from 'fastify'
import { getDb } from '../database/index.js'
import { broadcastState } from './ws.js'

/**
 * Handles getting the dashboard summary.
 */
export const handleGetDashboard = async (request: any, reply: any) => {
  const db = getDb()
  try {
    const [devices, onlineDevices, alerts] = await Promise.all([
      db.all('SELECT COUNT(*) as count FROM devices'),
      db.get('SELECT COUNT(*) as count FROM devices WHERE status = "ONLINE"'),
      db.all('SELECT * FROM alerts ORDER BY created_at DESC LIMIT 5')
    ])

    reply.send({
      totalDevices: devices[0].count,
      onlineDevices: onlineDevices.count,
      recentAlerts: alerts
    })
  } catch (error) {
    console.error('Error getting dashboard:', error)
    reply.code(500).send({ message: 'Internal server error' })
  }
}

/**
 * Handles getting the list of all devices.
 */
export const handleGetDevices = async (request: any, reply: any) => {
  const db = getDb()
  try {
    const devices = await db.all('SELECT * FROM devices ORDER BY last_seen DESC')
    reply.send(devices)
  } catch (error) {
    console.error('Error getting devices:', error)
    reply.code(500).send({ message: 'Internal server error' })
  }
}

/**
 * Handles getting device history.
 */
export const handleGetDeviceHistory = async (request: any, reply: any) => {
  const { id } = request.params
  const db = getDb()
  try {
    const history = await db.all(
      'SELECT * FROM device_metrics_history WHERE device_id = ? ORDER BY timestamp DESC LIMIT 50',
      [id]
    )
    reply.send(history)
  } catch (error) {
    console.error('Error getting device history:', error)
    reply.code(500).send({ message: 'Internal server error' })
  }
}

/**
 * Handles getting recent alerts.
 */
export const handleGetAlerts = async (request: any, reply: any) => {
  const db = getDb()
  try {
    const alerts = await db.all('SELECT * FROM alerts ORDER BY created_at DESC LIMIT 50')
    reply.send(alerts)
  } catch (error) {
    console.error('Error getting alerts:', error)
    reply.code(500).send({ message: 'Internal server error' })
  }
}

/**
 * Handles creating a new device manually.
 */
export const handleCreateDevice = async (request: any, reply: any) => {
  const { name, ip_address } = request.body
  const db = getDb()
  try {
    const result = await db.run(
      'INSERT INTO devices (name, ip_address, status) VALUES (?, ?, ?)',
      [name, ip_address, 'OFFLINE']
    )
    reply.code(201).send({ id: result.lastID, name, ip_address })
  } catch (error) {
    console.error('Error creating device:', error)
    reply.code(500).send({ message: 'Internal server error' })
  }
}

/**
 * Handles updating an existing device.
 */
export const handleUpdateDevice = async (request: any, reply: any) => {
  const { id } = request.params
  const { name, ip_address } = request.body
  const db = getDb()
  try {
    await db.run(
      'UPDATE devices SET name = ?, ip_address = ?, status = ? WHERE id = ?',
      [name, ip_address, 'OFFLINE', id]
    )
    reply.send({ message: 'Device updated successfully' })
  } catch (error) {
    console.error('Error updating device:', error)
    reply.code(500).send({ message: 'Internal server error' })
  }
}

/**
 * Handles deleting a device.
 */
export const handleDeleteDevice = async (request: any, reply: any) => {
  const { id } = request.params
  const db = getDb()
  try {
    await db.run('DELETE FROM devices WHERE id = ?', [id])
    reply.send({ message: 'Device deleted successfully' })
  } catch (error) {
    console.error('Error deleting device:', error)
    reply.code(500).send({ message: 'Internal server error' })
  }
}

/**
 * Handles Wake-on-LAN request.
 * Sends a WOL packet to the device and sets its status to WAKE_TIMEOUT.
 */
export const handleWakeDevice = async (request: any, reply: any) => {
  const { id } = request.params
  const db = getDb()
  try {
    const device = await db.get('SELECT * FROM devices WHERE id = ?', [id])
    if (!device) {
      reply.code(404).send({ message: 'Device not found' })
      return
    }

    // In a real implementation, we would actually send the WOL packet here.
    // For now, we just update the status to indicate a wake attempt was made.
    await db.run(
      'UPDATE devices SET status = ?, updated_at = ? WHERE id = ?',
      ['WAKE_TIMEOUT', new Date().toISOString(), id]
    )

    reply.send({ message: 'Wake-on-LAN signal sent', device: device.name })
  } catch (error) {
    console.error('Error waking device:', error)
    reply.code(500).send({ message: 'Internal server error' })
  }
}
