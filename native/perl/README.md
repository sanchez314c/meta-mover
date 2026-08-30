# Bundled Perl runtime

META Mover's Linux x64 package includes a static Perl 5.42.0 interpreter plus the 11 core module files exercised by ExifTool's version probe and JPEG/PNG metadata reads. It does not copy the build host's Perl or `@INC` tree.

Provenance:

- Source: `https://www.cpan.org/src/5.0/perl-5.42.0.tar.gz`
- Source SHA-256: `e093ef184d7f9a1b9797e2465296f55510adb6dab8842b0c3ed53329663096dc`
- Build: `./Configure -des -Uuseshrplib -Uusedl -Dldflags=-static -Dccflags=-O2 -Doptimize=-O2`, then `make -j$(nproc)`
- Runtime SHA-256: `2b98d636dfe40bf7752d43fb0f4f919547ed0f2f727a5a5cf8fcee046f31ed91`
- Binary evidence: ELF x86-64, statically linked, GNU/Linux 3.2.0 minimum ABI, no ELF interpreter, no `DT_NEEDED` entries

The upstream `Artistic` and `Copying` license files are retained beside this document.
