<?php

/**
 * The signalling piplet, exercised over real HTTP against a real `php -S`.
 * The file is self-modifying, so every case serves a throwaway copy, never
 * the repository file.
 */

const PIPLET_BASE = 'http://127.0.0.1:18792/';

function piplet(callable $run, ?callable $mutateSource = null): void
{
    $directory = sys_get_temp_dir() . '/kandelo-signalling-' . bin2hex(random_bytes(8));
    mkdir($directory);
    $copy = $directory . '/piplet.php';
    $source = file_get_contents(dirname(__DIR__) . '/piplet.php');
    file_put_contents($copy, $mutateSource === null ? $source : $mutateSource($source));
    $server = proc_open(
        ['php', '-S', '127.0.0.1:18792', $copy],
        [['file', '/dev/null', 'r'], ['file', '/dev/null', 'w'], ['file', '/dev/null', 'w']],
        $pipes,
    );
    try {
        $ready = false;
        for ($attempt = 0; $attempt < 50 && !$ready; $attempt++) {
            $ready = read('readiness-probe')['status'] === 404;
            if (!$ready) {
                usleep(100000);
            }
        }
        expect($ready)->toBeTrue('the signalling piplet did not start');
        $run($copy);
    } finally {
        proc_terminate($server);
        proc_close($server);
        foreach (scandir($directory) as $entry) {
            if ($entry === '.' || $entry === '..') {
                continue;
            }
            unlink($directory . '/' . $entry);
        }
        rmdir($directory);
    }
}

function request(string $method, string $query, ?string $code = null): array
{
    $options = ['method' => $method, 'ignore_errors' => true, 'timeout' => 5];
    if ($code !== null) {
        $options['header'] = 'Content-Type: text/plain';
        $options['content'] = $code;
    }
    set_error_handler(fn (): bool => true);
    try {
        $body = file_get_contents(PIPLET_BASE . $query, false, stream_context_create(['http' => $options]));
        $lines = $http_response_header ?? [];
    } finally {
        restore_error_handler();
    }
    $status = 0;
    $headers = [];
    foreach ($lines as $line) {
        if (preg_match('#^HTTP/\S+ (\d{3})#', $line, $match) === 1) {
            $status = (int) $match[1];
            continue;
        }
        [$key, $value] = explode(':', $line, 2) + [1 => ''];
        $headers[strtolower($key)] = trim($value);
    }
    return ['status' => $status, 'headers' => $headers, 'body' => $body === false ? null : $body];
}

function read(string $name): array
{
    return request('GET', "?session=$name");
}

function offer(string $name, string $code = 'kandelo1:offer'): array
{
    return request('POST', "?session=$name&role=offer", $code);
}

function answer(string $name, string $code = 'kandelo1:answer'): array
{
    return request('POST', "?session=$name&role=answer", $code);
}

test('a session carries an offer and one answer', function (): void {
    piplet(function (string $copy): void {
        expect(read('foo')['status'])->toBe(404);
        expect(offer('foo')['status'])->toBe(201);
        $hosted = json_decode(read('foo')['body'], true);
        expect($hosted['offer'])->toBe('kandelo1:offer');
        expect($hosted['answer'])->toBeNull();
        expect(answer('foo')['status'])->toBe(200);
        $joined = json_decode(read('foo')['body'], true);
        expect($joined['answer'])->toBe('kandelo1:answer');
        expect(answer('foo', 'kandelo1:late')['status'])->toBe(409);
        expect(file_get_contents($copy))->toContain('"kandelo1:answer"');
    });
});

test('hosting again replaces the session', function (): void {
    piplet(function (): void {
        offer('foo');
        answer('foo');
        expect(offer('foo', 'kandelo1:fresh')['status'])->toBe(201);
        $fresh = json_decode(read('foo')['body'], true);
        expect($fresh['offer'])->toBe('kandelo1:fresh');
        expect($fresh['answer'])->toBeNull();
    });
});

test('a session name is lowercase words separated by dashes', function (): void {
    piplet(function (): void {
        expect(read('foo-bar-baz-qux-quux-corge')['status'])->toBe(404);
        $names = [
            'bad/name',
            'Foo',
            'foo3',
            'foo_bar',
            'foo.bar',
            '-foo',
            'foo-',
            'foo--bar',
            str_repeat('a', 65),
        ];
        foreach ($names as $name) {
            expect(read($name)['status'])->toBe(422, $name);
            expect(offer($name)['status'])->toBe(422, $name);
        }
    });
});

test('malformed requests are refused', function (): void {
    piplet(function (): void {
        expect(offer('foo', 'not a code')['status'])->toBe(422);
        expect(answer('foo')['status'])->toBe(404);
        expect(request('POST', '?session=foo&role=nope', 'kandelo1:x')['status'])->toBe(422);
        expect(request('DELETE', '?session=foo')['status'])->toBe(405);
    });
});

test('a connect code is 1 to 65536 bytes', function (): void {
    piplet(function (): void {
        expect(offer('foo', '')['status'])->toBe(413);
        expect(offer('foo', str_pad('kandelo1:', 65537, 'a'))['status'])->toBe(413);
        expect(offer('foo', str_pad('kandelo1:', 65536, 'a'))['status'])->toBe(201);
    });
});

test('a full server refuses a new session but not a re-offer', function (): void {
    piplet(
        function (): void {
            expect(offer('foo')['status'])->toBe(201);
            expect(offer('bar')['status'])->toBe(201);
            expect(offer('baz')['status'])->toBe(503);
            expect(offer('foo', 'kandelo1:fresh')['status'])->toBe(201);
        },
        fn (string $source): string => str_replace(
            'MATCH_MAX_SESSIONS = 256',
            'MATCH_MAX_SESSIONS = 2',
            $source,
        ),
    );
});

test('responses are CORS-open for the browser client', function (): void {
    piplet(function (): void {
        expect(request('OPTIONS', '?session=foo')['status'])->toBe(204);
        $response = read('foo');
        expect($response['headers']['access-control-allow-origin'])->toBe('*');
        expect($response['headers']['cross-origin-resource-policy'])->toBe('cross-origin');
    });
});

test('sessions expire and are pruned from the file', function (): void {
    piplet(
        function (string $copy): void {
            offer('shortlived');
            usleep(1100000);
            expect(read('shortlived')['status'])->toBe(404);
            expect(answer('shortlived')['status'])->toBe(404);
            offer('next');
            $stored = file_get_contents($copy);
            expect($stored)->not->toContain('shortlived');
            expect($stored)->toContain('next');
        },
        fn (string $source): string => str_replace(
            'MATCH_SESSION_TTL_SECONDS = 600',
            'MATCH_SESSION_TTL_SECONDS = 1',
            $source,
        ),
    );
});
