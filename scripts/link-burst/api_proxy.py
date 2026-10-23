"""Forward the published loopback port to the core API on the internal network."""
import asyncio


async def pipe(reader, writer):
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    finally:
        writer.close()


async def handle(reader, writer):
    try:
        upstream_reader, upstream_writer = await asyncio.open_connection("core", 3000)
    except OSError:
        writer.close()
        return
    await asyncio.gather(pipe(reader, upstream_writer), pipe(upstream_reader, writer),
                         return_exceptions=True)


async def main():
    server = await asyncio.start_server(handle, "0.0.0.0", 3000)
    async with server:
        await server.serve_forever()


asyncio.run(main())
