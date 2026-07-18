#pragma once

#if !defined(_MT)
#error "CX-004 release fixtures require the static multithreaded CRT"
#endif

#if defined(_DLL)
#error "CX-004 release fixtures forbid the dynamic CRT"
#endif

#if defined(_DEBUG)
#error "CX-004 release fixtures require the retail static CRT"
#endif
