//! Kandelo Rust guest fixture (P5): std::net TCP loopback.
//! A server thread binds 127.0.0.1:0, the client connects, sends a
//! message, the server echoes it back. Exercises socket/bind/listen/
//! accept/connect/read/write and the sockaddr_in layout. Uses a literal
//! IP so it does not depend on getaddrinfo/DNS (a Kandelo stub).
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::thread;

fn main() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let addr = listener.local_addr().expect("local_addr");
    println!("listening on {addr}");

    let server = thread::spawn(move || {
        let (mut stream, peer) = listener.accept().expect("accept");
        println!("accepted from {peer}");
        let mut buf = [0u8; 64];
        let n = stream.read(&mut buf).expect("server read");
        stream.write_all(&buf[..n]).expect("server write");
    });

    let mut client = TcpStream::connect(addr).expect("connect");
    client.write_all(b"ping").expect("client write");
    let mut resp = String::new();
    client.read_to_string(&mut resp).expect("client read");
    server.join().expect("server thread panicked");

    println!("echo response = {resp:?}");
    assert_eq!(resp, "ping", "loopback echo mismatch");
    println!("std::net TCP loopback OK");
}
