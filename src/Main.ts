import { initEven } from './even'
import { updateStatus } from './ui'

let evenInstance: any = null

async function start() {

  const connectBtn = document.getElementById("connectBtn")
  const actionBtn = document.getElementById("actionBtn")

  connectBtn?.addEventListener("click", async () => {

    updateStatus("Connecting...")

    try {
      const { even } = await initEven()

      evenInstance = even

      updateStatus("Connected to Even bridge")

    } catch (err) {
      console.error(err)
      updateStatus("Connection failed")
    }
  })

  actionBtn?.addEventListener("click", async () => {

    if (!evenInstance) {
      updateStatus("Not connected")
      return
    }

    updateStatus("Sending demo action...")

    // Example action placeholder
    // Replace with real SDK call once integrating device features

    console.log("Demo action sent")

    updateStatus("Done")
  })
}

start()

